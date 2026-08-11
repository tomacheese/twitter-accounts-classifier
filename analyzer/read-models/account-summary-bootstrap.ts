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

const MODEL_KEY = 'account_summary'
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
 * `ReadModelBootstrap` 行が既に存在する場合に呼ぶ。status が `pending`/`running`
 * のまま、進行可能な `account_summary_bootstrap` WorkItem が 1 件も無い状態を
 * orphan とみなし、fresh な triggerId で 1 件 enqueue して自己回復する。
 * 行を `FOR UPDATE` でロックしたトランザクション内で判定するため、
 * analyzer の複数インスタンスが同時に起動しても WorkItem を二重に enqueue しない。
 * `completed`/`failed` (bootstrap 自体の致命的失敗) はこの自己回復の対象外とする。
 * @param prisma - Prisma クライアント
 */
async function recoverOrphanedBootstrapIfNeeded(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM "ReadModelBootstrap" WHERE "modelKey" = ${MODEL_KEY} FOR UPDATE
    `
    const state = rows.at(0)
    if (!state || (state.status !== 'pending' && state.status !== 'running')) return

    const progressableCount = await tx.analysisWorkItem.count({
      where: {
        kind: 'account_summary_bootstrap',
        status: { in: PROGRESSABLE_WORK_ITEM_STATUSES },
      },
    })
    if (progressableCount > 0) return

    await tx.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
      },
    })
  })
}

/**
 * analyzer 起動時に呼ぶ。`ReadModelBootstrap` 行が無ければ winner-takes-all で
 * 作成した worker だけが最初の `account_summary_bootstrap` WorkItem を enqueue する。
 * 行の作成と WorkItem の enqueue を 1 つのトランザクションにまとめることで、
 * 「行だけ作られて WorkItem が無い」状態を途中クラッシュでも発生させない。
 * 既に行が存在する場合は {@link recoverOrphanedBootstrapIfNeeded} で、
 * status が `pending`/`running` のまま進行可能な WorkItem が 1 件も無い
 * orphan 状態からの自己回復を試みる。
 * @param prisma - Prisma クライアント
 */
export async function enqueueAccountSummaryBootstrapIfNeeded(prisma: PrismaClient): Promise<void> {
  const insertedNewRow = await prisma.$transaction(async (tx) => {
    const inserted = await tx.$queryRaw<{ modelKey: string }[]>`
      INSERT INTO "ReadModelBootstrap" ("modelKey", "status", "updatedAt")
      VALUES (${MODEL_KEY}, 'pending', now())
      ON CONFLICT ("modelKey") DO NOTHING
      RETURNING "modelKey"
    `
    if (inserted.length === 0) return false

    await tx.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
      },
    })
    return true
  })

  if (!insertedNewRow) {
    await recoverOrphanedBootstrapIfNeeded(prisma)
  }
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
 * `Account`/`AccountLabelLatest`/直近の active `ReviewFinding` を baseline として
 * chunk 単位で `AccountSummaryLatest`/`AccountClassificationLatest` を構築する。
 * `AccountLabelChange` への書き込みは行わない (過去の変更イベントを捏造しない)。
 * `ReadModelBootstrap` 行を `FOR UPDATE` でロックしたトランザクション内で
 * cursor の読み取りから次 chunk の enqueue 判定まで行うため、複数 worker が
 * 同時に処理しても同じ chunk を二重に進めない。
 * @param prisma - Prisma クライアント
 * @param _workItem - `triggerType: 'account_summary_bootstrap_chunk'` の WorkItem
 * @param options - chunk サイズ等のオプション
 */
export async function processAccountSummaryBootstrap(
  prisma: PrismaClient,
  _workItem: AnalysisWorkItem,
  options: ProcessAccountSummaryBootstrapOptions = {},
): Promise<void> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE

  try {
    const chunkWatermarkAt = await prisma.$transaction(
      async (tx): Promise<Date | null> => {
        // enqueueAccountSummaryBootstrapIfNeeded を経ずに WorkItem だけが存在する
        // (テストや手動再実行) 場合でも進行できるよう、行が無ければここで作る。
        await tx.$executeRaw`
        INSERT INTO "ReadModelBootstrap" ("modelKey", "status", "updatedAt")
        VALUES (${MODEL_KEY}, 'pending', now())
        ON CONFLICT ("modelKey") DO NOTHING
      `
        const rows = await tx.$queryRaw<{ status: string; cursor: string | null }[]>`
        SELECT "status", "cursor" FROM "ReadModelBootstrap" WHERE "modelKey" = ${MODEL_KEY} FOR UPDATE
      `
        const state = rows.at(0)
        if (!state || state.status === 'completed') return null

        await tx.readModelBootstrap.update({
          where: { modelKey: MODEL_KEY },
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
          const [labelLatestRows, activeFindings, labelDefinitions, observationRows] =
            await Promise.all([
              tx.accountLabelLatest.findMany({ where: { accountId: { in: accountIds } } }),
              findActiveFindingsForAccounts(
                tx as unknown as PrismaClient,
                accountIds,
                chunkWatermarkAt ?? new Date(),
              ),
              tx.labelDefinition.findMany({ select: { id: true, key: true } }),
              // relabel は AccountClassificationObservation を作らないため、この行が無い
              // アカウントは AccountLabelLatest.labeledAt のみに基づく freshness にフォールバックする。
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
              // 増分更新側 (processAccountSummaryRefresh) は実際の変化検出結果を使うが、
              // bootstrap 側はここで無条件に classificationObservedAt と同値にしており、
              // その非対称は本 PR のスコープ外の既存差異として維持する。
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
              })
            }
          }
          await upsertAccountSummaryLatest(tx as unknown as PrismaClient, summaryRows)
          await upsertAccountClassificationLatest(tx as unknown as PrismaClient, classificationRows)
        }

        const nextCursor = accounts.at(-1)?.id ?? state.cursor
        const isDone = accounts.length < chunkSize
        await tx.readModelBootstrap.update({
          where: { modelKey: MODEL_KEY },
          data: {
            cursor: nextCursor,
            processedCount: { increment: accounts.length },
            ...(isDone ? { status: 'completed', completedAt: new Date() } : {}),
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
            data: {
              kind: 'account_summary_bootstrap',
              triggerType: 'account_summary_bootstrap_chunk',
              triggerId: randomUUID(),
            },
          })
        }

        return chunkWatermarkAt
      },
      { timeout: BOOTSTRAP_TRANSACTION_TIMEOUT_MS },
    )

    // このチャンクで実際に処理した Account が無い (他 worker が先に進めた) 場合は
    // 鮮度を更新する新しい観測が無いため、ReadModelState には触れない。
    if (chunkWatermarkAt) {
      await touchAccountSummaryLatestState(prisma, chunkWatermarkAt)
    }
  } catch (error) {
    // 失敗記録の書き込みが更に失敗しても、呼び出し元へは本来の原因を伝える。
    try {
      await prisma.readModelBootstrap.updateMany({
        where: { modelKey: MODEL_KEY, status: { not: 'completed' } },
        data: { status: 'failed', errorSummary: String(error) },
      })
      await markAccountSummaryLatestFailed(prisma, String(error))
    } catch (bookkeepingError) {
      logger.error(`failed to record account_summary_bootstrap failure`, bookkeepingError as Error)
    }
    throw error
  }
}
