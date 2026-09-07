import { randomUUID } from 'node:crypto'
import { Logger } from '@book000/node-utils'
import type { LabelDefinition, Prisma, PrismaClient } from '../generated/prisma'
import type { LabelRule, LabelRuleResult } from '../labels/types'
import { enqueueWorkItem } from './analysis-work-item-repository'

const logger = Logger.configure('label-repository')

export interface LabelDefinitionInput {
  key: string
  description: string
  currentRuleVersion: string
}

export async function ensureLabelDefinition(
  prisma: PrismaClient,
  input: LabelDefinitionInput,
): Promise<LabelDefinition> {
  return prisma.labelDefinition.upsert({
    where: { key: input.key },
    create: input,
    update: { description: input.description, currentRuleVersion: input.currentRuleVersion },
  })
}

/**
 * @param prisma - Prisma クライアント
 * @param rules - `LabelDefinition` の存在を保証する対象ルール
 * @returns 各ルールの key からその `LabelDefinition` id へのマップ
 */
export async function ensureLabelDefinitionsForRules(
  prisma: PrismaClient,
  rules: LabelRule[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    rules.map(async (rule) => {
      const definition = await ensureLabelDefinition(prisma, {
        key: rule.key,
        description: rule.description,
        currentRuleVersion: rule.version,
      })
      return [rule.key, definition.id] as const
    }),
  )
  return new Map(entries)
}

/**
 * `AccountClassificationObservation.classificationSnapshot` に格納する 1 ラベル分の内容。
 * analyzer 側の分岐ロジックが対応バージョンを判定するため、
 * `snapshotVersion` とセットで保存する。
 */
export interface ClassificationSnapshotEntry {
  labelDefinitionId: string
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  evaluable: boolean
  labeledAt: string
}

/** `AccountClassificationObservation.snapshotVersion` の現行値。 */
export const ACCOUNT_CLASSIFICATION_SNAPSHOT_VERSION = 1

export interface AccountLabelBulkInput {
  accountId: string
  labelDefinitionId: string
  result: LabelRuleResult
  method: string
  ruleVersion: string
}

/** 複数 row の writer 間で lock 順序を共有するための正準順序。 */
function orderAccountLabelBulkInputs(labels: AccountLabelBulkInput[]): AccountLabelBulkInput[] {
  return labels.toSorted(
    (left, right) =>
      left.accountId.localeCompare(right.accountId) ||
      left.labelDefinitionId.localeCompare(right.labelDefinitionId),
  )
}

export interface RecordAccountLabelsBulkForAccountsParams {
  /** 記録対象の評価結果一覧。各行が自分自身の `accountId` を持つ。 */
  labels: AccountLabelBulkInput[]
  /** どの処理がこの行を書いたか (crawl・relabel など)。 */
  sourceKind: string
  /** 発生源となった run の ID。 */
  sourceId?: string
  /** 発生源となったログインアカウント。 */
  sourceUsername?: string
}

/**
 * `recordAccountLabelsBulkLatestOnlyForAccounts` が SQL 呼び出しを分割する行数。
 * この値を超えて 1 回の `$queryRaw` にまとめると、Postgres の推定コストが `jit_above_cost` を超えて JIT コンパイルが走り、実行時間より長いコンパイル時間がかかる。
 */
const RECORD_ACCOUNT_LABELS_BULK_SUB_CHUNK_SIZE = 2000

/**
 * 複数アカウント分の評価結果をまとめて、アカウントごとの往復なしで記録する。
 * `AccountLabelLatest` の現在値だけを更新し、`AccountLabel` への履歴 INSERT は行わない。
 * `AccountLabelLatest` への変化は `AccountLabelChange` トリガーが引き続き検出するため、
 * viewer の変更履歴表示はこの経路でも失われない。
 * @param prisma - Prisma クライアント
 * @param params - 記録対象のアカウントを跨いだ評価結果一覧
 */
export async function recordAccountLabelsBulkLatestOnlyForAccounts(
  prisma: PrismaClient | Prisma.TransactionClient,
  params: RecordAccountLabelsBulkForAccountsParams,
): Promise<void> {
  const orderedLabels = orderAccountLabelBulkInputs(params.labels)
  for (
    let offset = 0;
    offset < orderedLabels.length;
    offset += RECORD_ACCOUNT_LABELS_BULK_SUB_CHUNK_SIZE
  ) {
    const subChunk = orderedLabels.slice(offset, offset + RECORD_ACCOUNT_LABELS_BULK_SUB_CHUNK_SIZE)
    if (subChunk.length === 0) continue

    const accountIds = subChunk.map((label) => label.accountId)
    const labelDefinitionIds = subChunk.map((label) => label.labelDefinitionId)
    const values = subChunk.map((label) => label.result.value)
    const confidences = subChunk.map((label) => label.result.confidence)
    const reasons = subChunk.map((label) => label.result.reason)
    const methods = subChunk.map((label) => label.method)
    const ruleVersions = subChunk.map((label) => label.ruleVersion)
    const evaluables = subChunk.map((label) => label.result.evaluable ?? true)
    const { sourceKind, sourceId, sourceUsername } = params

    const rows = await prisma.$queryRaw<
      { accountId: string; labelDefinitionId: string; latestUpserted: boolean }[]
    >`
      WITH shared_now AS (
        SELECT now() AS "labeledAt"
      ),
      input_rows AS (
        SELECT * FROM UNNEST(${accountIds}::text[], ${labelDefinitionIds}::text[], ${values}::boolean[], ${confidences}::double precision[], ${reasons}::text[], ${methods}::text[], ${ruleVersions}::text[], ${evaluables}::boolean[])
          AS u("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "evaluable")
      ),
      to_upsert AS (
        SELECT ir.*
        FROM input_rows ir
        LEFT JOIN "AccountLabelLatest" al
          ON al."accountId" = ir."accountId" AND al."labelDefinitionId" = ir."labelDefinitionId"
        WHERE al."accountId" IS NULL
           OR al."value" IS DISTINCT FROM ir."value"
           OR al."ruleVersion" IS DISTINCT FROM ir."ruleVersion"
           OR al."confidence" IS DISTINCT FROM ir."confidence"
           OR al."reason" IS DISTINCT FROM ir."reason"
           OR al."method" IS DISTINCT FROM ir."method"
           OR al."evaluable" IS DISTINCT FROM ir."evaluable"
      ),
      upserted AS (
        INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "evaluable", "labeledAt", "sourceKind", "sourceId", "sourceUsername")
        SELECT tu."accountId", tu."labelDefinitionId", tu."value", tu."confidence", tu."reason", tu."method", tu."ruleVersion", tu."evaluable", shared_now."labeledAt", ${sourceKind}, ${sourceId ?? null}, ${sourceUsername ?? null}
        FROM (
          SELECT tu.*
          FROM to_upsert tu
          ORDER BY tu."accountId", tu."labelDefinitionId"
        ) tu
        CROSS JOIN shared_now
        ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE
        SET "value" = EXCLUDED."value", "confidence" = EXCLUDED."confidence", "reason" = EXCLUDED."reason",
            "method" = EXCLUDED."method", "ruleVersion" = EXCLUDED."ruleVersion", "evaluable" = EXCLUDED."evaluable", "labeledAt" = EXCLUDED."labeledAt",
            "sourceKind" = EXCLUDED."sourceKind", "sourceId" = EXCLUDED."sourceId", "sourceUsername" = EXCLUDED."sourceUsername"
        WHERE "AccountLabelLatest"."labeledAt" <= EXCLUDED."labeledAt"
        RETURNING "accountId", "labelDefinitionId"
      )
      SELECT tu."accountId", tu."labelDefinitionId",
        EXISTS (
          SELECT 1 FROM upserted u
          WHERE u."accountId" = tu."accountId" AND u."labelDefinitionId" = tu."labelDefinitionId"
        ) AS "latestUpserted"
      FROM to_upsert tu
    `

    for (const row of rows) {
      if (!row.latestUpserted) {
        logger.warn(
          `recordAccountLabelsBulkLatestOnlyForAccounts: AccountLabelLatest upsert guard skipped the write (accountId=${row.accountId}, labelDefinitionId=${row.labelDefinitionId})`,
        )
      }
    }
  }
}
/** recordCrawlAccountLabelsAtomic の入力。1 author 分のルール結果一覧を含む。 */
export interface RecordCrawlAccountLabelsAtomicParams {
  /** ルール適用対象の Account ID。 */
  accountId: string
  /** 呼び出し元の CrawlRun ID。 */
  crawlRunId: string
  /** 処理中のログインアカウントの username。 */
  username: string
  /** author 1 件分のルール適用結果一覧。 */
  labels: {
    labelDefinitionId: string
    result: LabelRuleResult
    method: string
    ruleVersion: string
  }[]
}

/** `CrawlAccountLabelRun` への claim に成功した 1 ルール分の結果。 */
interface ClaimedLabelRow {
  labelDefinitionId: string
  method: string
  ruleVersion: string
  result: LabelRuleResult
}

/**
 * 1 author 分のルール結果をまとめて atomic に永続化する。
 * `CrawlAccountLabelRun` の claim をまとめて INSERT し、成功した行だけ
 * `AccountLabel`/`AccountLabelLatest` へ書き込んでから、claim が 1 件でも
 * 成功していれば `AccountClassificationObservation` を 1 行作成する。
 * 全 claim が空振り (再開時の重複呼び出し) の場合は observation を作らず null を返す。
 * 自前で transaction を開始しないため、呼び出し元が `tx as unknown as PrismaClient` を渡せば、
 * 外側の transaction に合成できる。
 * @param prisma - Prisma クライアント (または transaction client)
 * @param params - 対象アカウントと author 分のルール結果一覧
 * @returns 作成した `AccountClassificationObservation` の id。全 claim 空振りなら null
 */
export async function recordCrawlAccountLabelsAtomicWithinTx(
  prisma: PrismaClient,
  params: RecordCrawlAccountLabelsAtomicParams,
): Promise<string | null> {
  if (params.labels.length === 0) return null

  const claimIds = params.labels.map(() => randomUUID())
  const labelDefinitionIds = params.labels.map((label) => label.labelDefinitionId)
  const methods = params.labels.map((label) => label.method)
  const ruleVersions = params.labels.map((label) => label.ruleVersion)

  const claimedRows = await prisma.$queryRaw<
    { labelDefinitionId: string; method: string; ruleVersion: string }[]
  >`
    INSERT INTO "CrawlAccountLabelRun"
      ("id", "crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion")
    SELECT * FROM UNNEST(
      ${claimIds}::text[],
      ARRAY(SELECT ${params.crawlRunId} FROM generate_series(1, ${params.labels.length})),
      ARRAY(SELECT ${params.username} FROM generate_series(1, ${params.labels.length})),
      ARRAY(SELECT ${params.accountId} FROM generate_series(1, ${params.labels.length})),
      ${labelDefinitionIds}::text[],
      ${methods}::text[],
      ${ruleVersions}::text[]
    ) AS u("id", "crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion")
    ON CONFLICT ("crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion") DO NOTHING
    RETURNING "labelDefinitionId", "method", "ruleVersion"
  `
  if (claimedRows.length === 0) return null

  const claimedKeys = new Set(
    claimedRows.map((row) => `${row.labelDefinitionId} ${row.method} ${row.ruleVersion}`),
  )
  const claimedLabels: ClaimedLabelRow[] = params.labels
    .filter((label) =>
      claimedKeys.has(`${label.labelDefinitionId} ${label.method} ${label.ruleVersion}`),
    )
    .map((label) => ({
      labelDefinitionId: label.labelDefinitionId,
      method: label.method,
      ruleVersion: label.ruleVersion,
      result: label.result,
    }))

  const snapshotLabelDefinitionIds = [
    ...new Set(params.labels.map((label) => label.labelDefinitionId)),
  ].toSorted((left, right) => left.localeCompare(right))

  // 部分 resume は今回 claim できた subset だけを書き込む一方で、snapshot には active
  // label 全件を含める。subset を先に UPSERT してから残りを lock すると、別 writer が
  // 残りを lock した状態で subset を待つ循環を作れる。既存 Latest を正準順序で先に lock
  // してから書き込むことで、snapshot に含める既存 row と同じ lock 順序を保つ。
  await prisma.$queryRaw`
    SELECT "labelDefinitionId"
    FROM "AccountLabelLatest"
    WHERE "accountId" = ${params.accountId}
      AND "labelDefinitionId" = ANY(${snapshotLabelDefinitionIds}::text[])
    ORDER BY "labelDefinitionId"
    FOR UPDATE
  `

  await recordAccountLabelsBulkLatestOnlyForAccounts(prisma, {
    labels: claimedLabels.map((label) => ({ ...label, accountId: params.accountId })),
    sourceKind: 'crawl',
    sourceId: params.crawlRunId,
    sourceUsername: params.username,
  })

  // Observation の snapshot は、入力値ではなく永続化済み AccountLabelLatest を唯一の
  // source of truth とする。labeledAt guard が今回の UPSERT を拒否した場合、入力値を
  // snapshot に残すと「DB の Latest は新しい値なのに Observation だけ古い値」という
  // 逆転が起きる。さらに通常の SELECT だけでは、読取後〜Observation 作成の間に
  // relabel/crawl の別 writer が同じ Latest を更新できるため競合窓が残る。
  //
  // 最新状態を保存した後に全件を再読込する。READ COMMITTED では、直前の FOR UPDATE が
  // 待った並行 writer の commit もこの statement から見え、row lock は Observation/work-item
  // transaction の commit まで保持される。今回新規作成した Latest row もここで含める。
  const latestRows = await prisma.$queryRaw<
    {
      labelDefinitionId: string
      value: boolean
      confidence: number
      reason: string
      method: string
      ruleVersion: string
      evaluable: boolean
      labeledAt: Date
    }[]
  >`
    SELECT
      "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "evaluable", "labeledAt"
    FROM "AccountLabelLatest"
    WHERE "accountId" = ${params.accountId}
      AND "labelDefinitionId" = ANY(${snapshotLabelDefinitionIds}::text[])
    ORDER BY "labelDefinitionId"
    FOR UPDATE
  `
  const latestByLabelDefinitionId = new Map(
    latestRows.map((row) => [row.labelDefinitionId, row] as const),
  )
  const missingLabelDefinitionIds = snapshotLabelDefinitionIds.filter(
    (labelDefinitionId) => !latestByLabelDefinitionId.has(labelDefinitionId),
  )
  if (missingLabelDefinitionIds.length > 0) {
    throw new Error(
      `recordCrawlAccountLabelsAtomicWithinTx: AccountLabelLatest missing after claim persistence (accountId=${params.accountId}, labelDefinitionIds=${missingLabelDefinitionIds.join(',')})`,
    )
  }
  const classificationSnapshot: ClassificationSnapshotEntry[] = latestRows.map((row) => ({
    labelDefinitionId: row.labelDefinitionId,
    value: row.value,
    confidence: row.confidence,
    reason: row.reason,
    method: row.method,
    ruleVersion: row.ruleVersion,
    evaluable: row.evaluable,
    labeledAt: row.labeledAt.toISOString(),
  }))

  const observation = await prisma.accountClassificationObservation.create({
    data: {
      accountId: params.accountId,
      crawlRunId: params.crawlRunId,
      username: params.username,
      observedAt: new Date(),
      labelCount: claimedLabels.length,
      snapshotVersion: ACCOUNT_CLASSIFICATION_SNAPSHOT_VERSION,
      classificationSnapshot: classificationSnapshot as unknown as Prisma.InputJsonValue,
    },
  })

  // Observation の commit と WorkItem の enqueue が別トランザクションだと、
  // 片方だけ成功する状態 (refresh が永久に走らない、または存在しない
  // Observation を指す WorkItem) が生まれる。同一トランザクション内で
  // enqueue することで、Observation が確定した時点で refresh も必ず予約される。
  await enqueueWorkItem(prisma, {
    kind: 'account_summary_refresh',
    triggerType: 'account_classification_observation',
    triggerId: observation.id,
  })

  return observation.id
}

/**
 * {@link recordCrawlAccountLabelsAtomicWithinTx} を自前の transaction でラップする薄い wrapper。
 * @param prisma - Prisma クライアント
 * @param params - 対象アカウントと author 分のルール結果一覧
 * @returns 作成した `AccountClassificationObservation` の id。全 claim 空振りなら null
 */
export async function recordCrawlAccountLabelsAtomic(
  prisma: PrismaClient,
  params: RecordCrawlAccountLabelsAtomicParams,
): Promise<string | null> {
  return prisma.$transaction(
    (tx) => recordCrawlAccountLabelsAtomicWithinTx(tx as unknown as PrismaClient, params),
    { maxWait: 15_000, timeout: 15_000 },
  )
}

/**
 * 一度も評価されたことのない account への account_relabel enqueue を避けるための存在確認。
 * @param prisma - Prisma クライアント
 * @param accountIds - 存在確認する accountId の一覧
 * @returns AccountLabelLatest に既存行がある accountId の集合
 */
export async function filterAccountIdsWithExistingLabels(
  prisma: PrismaClient,
  accountIds: string[],
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set()
  const rows = await prisma.accountLabelLatest.findMany({
    where: { accountId: { in: accountIds } },
    select: { accountId: true },
    distinct: ['accountId'],
  })
  return new Set(rows.map((row) => row.accountId))
}
