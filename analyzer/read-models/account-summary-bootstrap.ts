import { randomUUID } from 'node:crypto'
import { Logger } from '@book000/node-utils'
import { Prisma, type AnalysisWorkItem, type PrismaClient } from '../generated/prisma'
import {
  upsertAccountClassificationLatest,
  upsertAccountSummaryLatest,
  touchAccountSummaryLatestState,
  markAccountSummaryLatestFailed,
  type AccountClassificationLatestRow,
  type UpsertAccountSummaryLatestInput,
} from './account-summary-latest'

const logger = Logger.configure('analyzer:account-summary-bootstrap')

/** 全 WorkItem 共通の kind。フェーズの区別は triggerType で行う。 */
const WORK_ITEM_KIND = 'account_summary_bootstrap'

/** legacy phase: `Account` 全件を cursor に `AccountSummaryLatest`/`AccountClassificationLatest` を構築する。 */
const LEGACY_MODEL_KEY = 'account_summary'
const LEGACY_TRIGGER = 'account_summary_bootstrap_chunk'

/** sampling phase: 既存 `AccountClassificationLatest` 行だけに `evaluable`/`labeledAt` を追いつかせる。 */
const SAMPLING_MODEL_KEY = 'account_summary_v2'
const SAMPLING_TRIGGER = 'account_summary_sampling_bootstrap_chunk'

const ACCOUNT_SUMMARY_LATEST_SCHEMA_VERSION = 2
const DEFAULT_CHUNK_SIZE = 2000
const BOOTSTRAP_TRANSACTION_TIMEOUT_MS = 60_000

/** account_summary_bootstrap WorkItem がまだ進行可能とみなせる status。 */
const PROGRESSABLE_WORK_ITEM_STATUSES = ['queued', 'leased', 'failed']

/** ReviewFindingOccurrence.stateTransition のうち、Finding が open 状態であることを表す値。 */
const OPEN_STATE_TRANSITIONS = new Set(['active', 'recurring', 'new_episode'])

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/**
 * @param a - 比較対象の severity (null は severity なし扱い)
 * @param b - 比較対象の severity
 * @returns より深刻な方の severity
 */
function maxSeverity(a: string | null, b: string): string {
  if (!a) return b
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b
}

/**
 * `modelKey`/`triggerType` の行が既に存在する場合に呼ぶ。status が `pending`/`running`
 * のまま、進行可能な WorkItem (同じ triggerType) が 1 件も無い状態を orphan とみなし、
 * fresh な triggerId で 1 件 enqueue して自己回復する。行を `FOR UPDATE` でロックした
 * トランザクション内で判定するため、analyzer の複数インスタンスが同時に起動しても
 * WorkItem を二重に enqueue しない。`completed`/`failed` (bootstrap 自体の致命的失敗)
 * はこの自己回復の対象外とする。progressable count を triggerType で絞るのは、
 * legacy/sampling 両フェーズが同じ kind を共有するため絞らないと互いの WorkItem を
 * 「進行可能」と誤検知してしまうからである。
 * @param prisma - Prisma クライアント
 * @param modelKey - 対象フェーズの `ReadModelBootstrap.modelKey`
 * @param triggerType - 対象フェーズの WorkItem triggerType
 */
async function recoverOrphanedPhaseIfNeeded(
  prisma: PrismaClient,
  modelKey: string,
  triggerType: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM "ReadModelBootstrap" WHERE "modelKey" = ${modelKey} FOR UPDATE
    `
    const state = rows.at(0)
    if (!state || (state.status !== 'pending' && state.status !== 'running')) return

    const progressableCount = await tx.analysisWorkItem.count({
      where: {
        kind: WORK_ITEM_KIND,
        triggerType,
        status: { in: PROGRESSABLE_WORK_ITEM_STATUSES },
      },
    })
    if (progressableCount > 0) return

    await tx.analysisWorkItem.create({
      data: { kind: WORK_ITEM_KIND, triggerType, triggerId: randomUUID() },
    })
  })
}

/**
 * 1 フェーズ分の `ReadModelBootstrap` 行を winner-takes-all で作成し、作成できた
 * worker だけが最初の WorkItem を enqueue する。既に行が存在する場合は
 * {@link recoverOrphanedPhaseIfNeeded} で orphan 状態からの自己回復を試みる。
 * @param prisma - Prisma クライアント
 * @param modelKey - 対象フェーズの `ReadModelBootstrap.modelKey`
 * @param triggerType - 対象フェーズの WorkItem triggerType
 * @returns このフェーズが既に `completed` かどうか (呼び出し元が次フェーズへ進むかの判定に使う)
 */
async function ensurePhaseQueued(
  prisma: PrismaClient,
  modelKey: string,
  triggerType: string,
): Promise<boolean> {
  const result = await prisma.$transaction(async (tx) => {
    const inserted = await tx.$queryRaw<{ modelKey: string }[]>`
      INSERT INTO "ReadModelBootstrap" ("modelKey", "status", "updatedAt")
      VALUES (${modelKey}, 'pending', now())
      ON CONFLICT ("modelKey") DO NOTHING
      RETURNING "modelKey"
    `
    if (inserted.length > 0) {
      await tx.analysisWorkItem.create({
        data: { kind: WORK_ITEM_KIND, triggerType, triggerId: randomUUID() },
      })
      return { insertedNewRow: true, status: 'pending' }
    }

    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM "ReadModelBootstrap" WHERE "modelKey" = ${modelKey}
    `
    return { insertedNewRow: false, status: rows.at(0)?.status ?? 'pending' }
  })

  if (!result.insertedNewRow) {
    await recoverOrphanedPhaseIfNeeded(prisma, modelKey, triggerType)
  }
  return result.status === 'completed'
}

/**
 * analyzer 起動時に呼ぶ。legacy phase (`account_summary`) の進行/自己回復を優先し、
 * それが `completed` になって初めて sampling phase (`account_summary_v2`) を
 * 進行/自己回復させる。本番は legacy phase が既に `completed` のため即座に
 * sampling phase が動き出す一方、fresh DB では legacy phase が先に完走するまで
 * sampling phase の WorkItem は enqueue されない。
 * @param prisma - Prisma クライアント
 */
export async function enqueueAccountSummaryBootstrapIfNeeded(prisma: PrismaClient): Promise<void> {
  const legacyCompleted = await ensurePhaseQueued(prisma, LEGACY_MODEL_KEY, LEGACY_TRIGGER)
  if (!legacyCompleted) return
  await ensurePhaseQueued(prisma, SAMPLING_MODEL_KEY, SAMPLING_TRIGGER)
}

/** processAccountSummaryBootstrap のオプション。テストでチャンクサイズを小さくするために使う。 */
export interface ProcessAccountSummaryBootstrapOptions {
  chunkSize?: number
}

/** watermark 時点で active だった Finding 1 件。 */
interface ActiveFindingAtWatermark {
  primaryScopeId: string
  severity: string
  sourceObservedAt: Date
}

/**
 * @param prisma - Prisma クライアント
 * @param accountIds - 対象 Account ID
 * @param watermark - この時刻以前の Finding だけを対象にする
 * @returns Account ごとの active Finding 件数・最高 severity・観測時刻
 */
async function findActiveFindingsForAccounts(
  prisma: PrismaClient,
  accountIds: string[],
  watermark: Date,
): Promise<ActiveFindingAtWatermark[]> {
  if (accountIds.length === 0) return []
  const rows = await prisma.$queryRaw<
    { primaryScopeId: string; severity: string; stateTransition: string; sourceObservedAt: Date }[]
  >`
    SELECT DISTINCT ON (o."findingId")
      f."primaryScopeId", o."severity", o."stateTransition", o."sourceObservedAt"
    FROM "ReviewFindingOccurrence" o
    JOIN "ReviewFinding" f ON f.id = o."findingId"
    WHERE f."primaryScopeType" = 'account'
      AND f."primaryScopeId" IN (${Prisma.join(accountIds)})
      AND o."sourceObservedAt" <= ${watermark}
    ORDER BY o."findingId", o."sourceObservedAt" DESC, o.id DESC
  `
  return rows
    .filter((row) => OPEN_STATE_TRANSITIONS.has(row.stateTransition))
    .map((row) => ({
      primaryScopeId: row.primaryScopeId,
      severity: row.severity,
      sourceObservedAt: row.sourceObservedAt,
    }))
}

/**
 * legacy phase の 1 chunk 分を処理する。`Account`/`AccountLabelLatest`/直近の
 * active `ReviewFinding` を baseline として `AccountSummaryLatest`/
 * `AccountClassificationLatest` を構築する。`AccountLabelChange` への書き込みは
 * 行わない (過去の変更イベントを捏造しない)。`evaluable`/`labeledAt` は常に
 * false/null で挿入し、sampling phase による意味的一致検証を経ずに eligible
 * 扱いにしない (fail-closed)。
 * @param tx - `ReadModelBootstrap` 行を `FOR UPDATE` でロック済みのトランザクション
 * @param chunkSize - 1 回で処理する Account 件数
 * @returns このチャンクで実際に処理した Account の最新 lastCrawledAt (処理が無ければ null)
 */
async function processLegacyChunk(tx: PrismaClient, chunkSize: number): Promise<Date | null> {
  await tx.$executeRaw`
    INSERT INTO "ReadModelBootstrap" ("modelKey", "status", "updatedAt")
    VALUES (${LEGACY_MODEL_KEY}, 'pending', now())
    ON CONFLICT ("modelKey") DO NOTHING
  `
  const rows = await tx.$queryRaw<{ status: string; cursor: string | null }[]>`
    SELECT "status", "cursor" FROM "ReadModelBootstrap" WHERE "modelKey" = ${LEGACY_MODEL_KEY} FOR UPDATE
  `
  const state = rows.at(0)
  if (!state || state.status === 'completed') return null

  await tx.readModelBootstrap.update({
    where: { modelKey: LEGACY_MODEL_KEY },
    data: { status: 'running', startedAt: state.cursor ? undefined : new Date() },
  })

  const accounts = await tx.account.findMany({
    take: chunkSize,
    ...(state.cursor ? { skip: 1, cursor: { id: state.cursor } } : {}),
    orderBy: { id: 'asc' },
    select: { id: true, screenName: true, displayName: true, lastCrawledAt: true },
  })

  let chunkWatermarkAt: Date | null = null
  for (const account of accounts) {
    if (!chunkWatermarkAt || account.lastCrawledAt > chunkWatermarkAt) {
      chunkWatermarkAt = account.lastCrawledAt
    }
  }

  if (accounts.length > 0) {
    const accountIds = accounts.map((account) => account.id)
    const [labelLatestRows, activeFindings, labelDefinitions, observationRows] = await Promise.all([
      tx.accountLabelLatest.findMany({ where: { accountId: { in: accountIds } } }),
      findActiveFindingsForAccounts(
        tx as unknown as PrismaClient,
        accountIds,
        chunkWatermarkAt ?? new Date(),
      ),
      tx.labelDefinition.findMany({ select: { id: true, key: true } }),
      // relabel は AccountClassificationObservation を作らないため、
      // 該当行が無いアカウントは labeledAt のみに基づく freshness にフォールバックする。
      tx.accountClassificationObservation.groupBy({
        by: ['accountId'],
        where: { accountId: { in: accountIds } },
        _max: { observedAt: true },
      }),
    ])
    const maxObservedAtByAccount = new Map(
      observationRows.map((row) => [row.accountId, row._max.observedAt]),
    )
    const labelKeyById = new Map(labelDefinitions.map((def) => [def.id, def.key]))
    const labelsByAccount = new Map<string, typeof labelLatestRows>()
    for (const row of labelLatestRows) {
      const list = labelsByAccount.get(row.accountId) ?? []
      list.push(row)
      labelsByAccount.set(row.accountId, list)
    }
    const findingsByAccount = new Map<
      string,
      { count: number; highestSeverity: string; observedAt: Date }
    >()
    for (const row of activeFindings) {
      const entry = findingsByAccount.get(row.primaryScopeId)
      findingsByAccount.set(row.primaryScopeId, {
        count: (entry?.count ?? 0) + 1,
        highestSeverity: maxSeverity(entry?.highestSeverity ?? null, row.severity),
        observedAt:
          entry && entry.observedAt > row.sourceObservedAt
            ? entry.observedAt
            : row.sourceObservedAt,
      })
    }

    const summaryRows: UpsertAccountSummaryLatestInput[] = []
    const classificationRows: AccountClassificationLatestRow[] = []
    for (const account of accounts) {
      const labels = labelsByAccount.get(account.id) ?? []
      const activeLabelKeys = labels
        .filter((label) => label.value)
        .map((label) => labelKeyById.get(label.labelDefinitionId))
        .filter((key): key is string => key !== undefined)
      let classificationObservedAt: Date | null = null
      for (const label of labels) {
        if (!classificationObservedAt || label.labeledAt > classificationObservedAt) {
          classificationObservedAt = label.labeledAt
        }
      }
      const observationMax = maxObservedAtByAccount.get(account.id) ?? null
      if (
        observationMax &&
        (!classificationObservedAt || observationMax > classificationObservedAt)
      ) {
        classificationObservedAt = observationMax
      }
      const finding = findingsByAccount.get(account.id)

      summaryRows.push({
        accountId: account.id,
        normalizedScreenName: account.screenName.toLowerCase(),
        normalizedDisplayName: account.displayName.toLowerCase(),
        searchDocument: `${account.screenName} ${account.displayName}`.toLowerCase(),
        profileObservedAt: account.lastCrawledAt,
        activeLabelKeys,
        activeLabelCount: activeLabelKeys.length,
        // bootstrap は変化検出を行わないため、classificationObservedAt と同値を書く。
        lastClassificationChangedAt: classificationObservedAt,
        classificationObservedAt,
        activeFindingCount: finding?.count ?? 0,
        highestFindingSeverity: finding?.highestSeverity ?? null,
        findingObservedAt: finding?.observedAt ?? null,
      })
      for (const label of labels) {
        classificationRows.push({
          accountId: label.accountId,
          labelDefinitionId: label.labelDefinitionId,
          value: label.value,
          confidence: label.confidence,
          reason: label.reason,
          method: label.method,
          ruleVersion: label.ruleVersion,
          observedAt: label.labeledAt,
          sourceObservationId: null,
          // sampling phase が AccountLabelLatest との意味的一致を検証した上で
          // 追いつかせるため、ここでは fail-closed な既定値のまま挿入する。
          evaluable: false,
          labeledAt: null,
        })
      }
    }
    await upsertAccountSummaryLatest(tx as unknown as PrismaClient, summaryRows)
    await upsertAccountClassificationLatest(tx as unknown as PrismaClient, classificationRows)
  }

  const nextCursor = accounts.at(-1)?.id ?? state.cursor
  const isDone = accounts.length < chunkSize
  await tx.readModelBootstrap.update({
    where: { modelKey: LEGACY_MODEL_KEY },
    data: {
      cursor: nextCursor,
      processedCount: { increment: accounts.length },
      ...(isDone ? { status: 'completed', completedAt: new Date(), errorSummary: null } : {}),
    },
  })

  // 分岐先の await 呼び出しがそれぞれ複数行のため、三項演算子にすると可読性が落ちる。
  // eslint-disable-next-line unicorn/prefer-ternary
  if (isDone) {
    await tx.analysisWorkItem.upsert({
      where: {
        kind_triggerType_triggerId: {
          kind: 'label_aggregate_refresh',
          triggerType: 'bootstrap_completion',
          triggerId: 'account_summary:bootstrap_completed',
        },
      },
      create: {
        kind: 'label_aggregate_refresh',
        triggerType: 'bootstrap_completion',
        triggerId: 'account_summary:bootstrap_completed',
      },
      update: {},
    })
  } else {
    await tx.analysisWorkItem.create({
      data: { kind: WORK_ITEM_KIND, triggerType: LEGACY_TRIGGER, triggerId: randomUUID() },
    })
  }

  return chunkWatermarkAt
}

/**
 * sampling phase の 1 chunk 分を処理する。既存の `AccountClassificationLatest` 行
 * (= 既存 sampling population) だけを対象に、`labeledAt IS NULL` かつ同じ
 * `(accountId, labelDefinitionId)` の `AccountLabelLatest` 行と意味的フィールド
 * (`value`/`confidence`/`reason`/`method`/`ruleVersion`) が完全一致する場合に限り、
 * `evaluable`/`labeledAt` を metadata-only で UPDATE する。`AccountLabelLatest` に
 * しか無い pair は新規 INSERT しない (`AccountLabelLatest` は既存 population の
 * 10 倍を超える規模のため、全件を classification 対象へ広げると本番ディスク容量を
 * 圧迫する)。`labeledAt IS NULL` を条件に含めることで、live refresh が既に設定した
 * `evaluable`/`labeledAt` を上書きしない (write-once)。`AccountClassificationLatest`
 * への UPDATE は `WeeklyReviewSampleBucketCount` trigger を経由するトランザクション
 * 内で行うため、eligibility 遷移は自動的に反映される。
 * cursor は `Account` 全件ではなく `AccountClassificationLatest` の distinct
 * `accountId` を PK 昇順で辿る (対象外の Account まで走査しないため)。
 * @param tx - `ReadModelBootstrap` 行を `FOR UPDATE` でロック済みのトランザクション
 * @param chunkSize - 1 回で処理する accountId 件数
 */
async function processSamplingChunk(tx: PrismaClient, chunkSize: number): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "ReadModelBootstrap" ("modelKey", "status", "updatedAt")
    VALUES (${SAMPLING_MODEL_KEY}, 'pending', now())
    ON CONFLICT ("modelKey") DO NOTHING
  `
  const rows = await tx.$queryRaw<{ status: string; cursor: string | null }[]>`
    SELECT "status", "cursor" FROM "ReadModelBootstrap" WHERE "modelKey" = ${SAMPLING_MODEL_KEY} FOR UPDATE
  `
  const state = rows.at(0)
  if (!state || state.status === 'completed') return

  await tx.readModelBootstrap.update({
    where: { modelKey: SAMPLING_MODEL_KEY },
    data: { status: 'running', startedAt: state.cursor ? undefined : new Date() },
  })

  const accountIdRows = await tx.$queryRaw<{ accountId: string }[]>(
    state.cursor
      ? Prisma.sql`
        SELECT DISTINCT "accountId" FROM "AccountClassificationLatest"
        WHERE "accountId" > ${state.cursor}
        ORDER BY "accountId" ASC
        LIMIT ${chunkSize}
      `
      : Prisma.sql`
        SELECT DISTINCT "accountId" FROM "AccountClassificationLatest"
        ORDER BY "accountId" ASC
        LIMIT ${chunkSize}
      `,
  )
  const accountIds = accountIdRows.map((row) => row.accountId)

  if (accountIds.length > 0) {
    await tx.$executeRaw`
      UPDATE "AccountClassificationLatest" AS c
      SET "evaluable" = l."evaluable", "labeledAt" = l."labeledAt"
      FROM "AccountLabelLatest" AS l
      WHERE l."accountId" = c."accountId"
        AND l."labelDefinitionId" = c."labelDefinitionId"
        AND c."labeledAt" IS NULL
        AND l."value" = c."value"
        AND l."confidence" = c."confidence"
        AND l."reason" = c."reason"
        AND l."method" = c."method"
        AND l."ruleVersion" = c."ruleVersion"
        AND c."accountId" = ANY(${accountIds}::text[])
    `
  }

  const nextCursor = accountIds.at(-1) ?? state.cursor
  const isDone = accountIds.length < chunkSize
  await tx.readModelBootstrap.update({
    where: { modelKey: SAMPLING_MODEL_KEY },
    data: {
      cursor: nextCursor,
      processedCount: { increment: accountIds.length },
      ...(isDone ? { status: 'completed', completedAt: new Date(), errorSummary: null } : {}),
    },
  })

  if (isDone) {
    // 行が無い場合に備えて INSERT ... ON CONFLICT にする。既存行があれば
    // schemaVersion だけを更新し、status 等の他フィールドには触れない。
    await tx.$executeRaw`
      INSERT INTO "ReadModelState" ("modelKey", "schemaVersion", "status")
      VALUES ('account_summary_latest', ${ACCOUNT_SUMMARY_LATEST_SCHEMA_VERSION}, 'healthy')
      ON CONFLICT ("modelKey") DO UPDATE SET "schemaVersion" = ${ACCOUNT_SUMMARY_LATEST_SCHEMA_VERSION}
    `
    await tx.analysisWorkItem.upsert({
      where: {
        kind_triggerType_triggerId: {
          kind: 'label_aggregate_refresh',
          triggerType: 'bootstrap_completion',
          triggerId: 'account_summary:bootstrap_completed',
        },
      },
      create: {
        kind: 'label_aggregate_refresh',
        triggerType: 'bootstrap_completion',
        triggerId: 'account_summary:bootstrap_completed',
      },
      update: {},
    })
  } else {
    await tx.analysisWorkItem.create({
      data: { kind: WORK_ITEM_KIND, triggerType: SAMPLING_TRIGGER, triggerId: randomUUID() },
    })
  }
}

/**
 * `workItem.triggerType` で legacy phase ({@link processLegacyChunk}) と
 * sampling phase ({@link processSamplingChunk}) を振り分けて 1 chunk 分処理する。
 * `ReadModelBootstrap` 行を `FOR UPDATE` でロックしたトランザクション内で
 * cursor の読み取りから次 chunk の enqueue 判定まで行うため、複数 worker が
 * 同時に処理しても同じ chunk を二重に進めない。未知の triggerType は
 * どちらのフェーズにも属さないため例外を投げる。
 * @param prisma - Prisma クライアント
 * @param workItem - `triggerType` が {@link LEGACY_TRIGGER}/{@link SAMPLING_TRIGGER} の WorkItem
 * @param options - chunk サイズ等のオプション
 */
export async function processAccountSummaryBootstrap(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
  options: ProcessAccountSummaryBootstrapOptions = {},
): Promise<void> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE

  let modelKey: string
  if (workItem.triggerType === LEGACY_TRIGGER) {
    modelKey = LEGACY_MODEL_KEY
  } else if (workItem.triggerType === SAMPLING_TRIGGER) {
    modelKey = SAMPLING_MODEL_KEY
  } else {
    throw new Error(`unknown account_summary_bootstrap trigger type: ${workItem.triggerType}`)
  }

  try {
    const chunkWatermarkAt = await prisma.$transaction(
      async (tx): Promise<Date | null> => {
        if (workItem.triggerType === LEGACY_TRIGGER) {
          return processLegacyChunk(tx as unknown as PrismaClient, chunkSize)
        }
        await processSamplingChunk(tx as unknown as PrismaClient, chunkSize)
        return null
      },
      { timeout: BOOTSTRAP_TRANSACTION_TIMEOUT_MS },
    )

    // このチャンクで実際に処理した Account が無い (他 worker が先に進めた、または
    // sampling phase で watermark を持たない) 場合は、鮮度を更新する新しい観測が
    // 無いため ReadModelState には触れない。
    if (chunkWatermarkAt) {
      await touchAccountSummaryLatestState(prisma, chunkWatermarkAt)
    }
  } catch (error) {
    // 失敗記録の書き込みが更に失敗しても、呼び出し元へは本来の原因を伝える。
    try {
      await prisma.readModelBootstrap.updateMany({
        where: { modelKey, status: { not: 'completed' } },
        data: { status: 'failed', errorSummary: String(error) },
      })
      await markAccountSummaryLatestFailed(prisma, String(error))
    } catch (bookkeepingError) {
      logger.error(`failed to record account_summary_bootstrap failure`, bookkeepingError as Error)
    }
    throw error
  }
}
