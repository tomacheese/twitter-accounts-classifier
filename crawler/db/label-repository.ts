import { randomUUID } from 'node:crypto'
import { Logger } from '@book000/node-utils'
import type { AccountLabel, LabelDefinition, PrismaClient } from '../generated/prisma'
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

export interface RecordAccountLabelParams {
  accountId: string
  labelDefinitionId: string
  result: LabelRuleResult
  method: string
  ruleVersion: string
}

export interface RecordCrawlAccountLabelParams extends RecordAccountLabelParams {
  crawlRunId: string
  username: string
}

interface RecordAccountLabelRow {
  latestUpserted: boolean
}

export interface RecordAccountLabelsBulkParams {
  accountId: string
  labels: {
    labelDefinitionId: string
    result: LabelRuleResult
    method: string
    ruleVersion: string
  }[]
  /** どの処理がこの行を書いたか (crawl・relabel など)。 */
  sourceKind: string
  /** 発生源となった run の ID。 */
  sourceId?: string
  /** 発生源となったログインアカウント。 */
  sourceUsername?: string
}

interface RecordAccountLabelsBulkRow {
  id: string
  accountId: string
  labelDefinitionId: string
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  evaluable: boolean
  labeledAt: Date | null
  historyInserted: boolean
  latestUpserted: boolean
  semanticNoOp: boolean
}

/**
 * 1アカウント分の評価結果をまとめて記録する: ラベルごとに `$queryRaw` を逐次発行する代わりに、
 * 列単位の配列を `UNNEST` で展開し、
 * `AccountLabel` への INSERT と `AccountLabelLatest` への UPSERT を 1 ラウンドトリップにまとめる。
 * `AccountLabelLatest` への UPSERT は値・confidence・reason・method・ruleVersion が不変なら行わない
 * (`recordCrawlAccountLabel` は claim 成立時に無条件で UPSERT する点が異なる)。
 * @param prisma - Prisma クライアント
 * @param params - 記録対象のアカウントと評価結果一覧
 * @returns 作成された `AccountLabel` 履歴行。`labels` と同じ順序とは限らないため、
 *   対応付けが必要なら `labelDefinitionId` で突き合わせる。
 */
export async function recordAccountLabelsBulk(
  prisma: PrismaClient,
  params: RecordAccountLabelsBulkParams,
): Promise<AccountLabel[]> {
  if (params.labels.length === 0) return []

  const ids = params.labels.map(() => randomUUID())
  const accountIds = params.labels.map(() => params.accountId)
  const labelDefinitionIds = params.labels.map((label) => label.labelDefinitionId)
  const values = params.labels.map((label) => label.result.value)
  const confidences = params.labels.map((label) => label.result.confidence)
  const reasons = params.labels.map((label) => label.result.reason)
  const methods = params.labels.map((label) => label.method)
  const ruleVersions = params.labels.map((label) => label.ruleVersion)
  const evaluables = params.labels.map((label) => label.result.evaluable ?? true)

  const rows = await prisma.$queryRaw<RecordAccountLabelsBulkRow[]>`
    WITH shared_now AS (
      SELECT now() AS "labeledAt"
    ),
    input_rows AS (
      SELECT * FROM UNNEST(${ids}::text[], ${accountIds}::text[], ${labelDefinitionIds}::text[], ${values}::boolean[], ${confidences}::double precision[], ${reasons}::text[], ${methods}::text[], ${ruleVersions}::text[], ${evaluables}::boolean[])
        AS u("id", "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "evaluable")
    ),
    to_insert AS (
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
    inserted_history AS (
      INSERT INTO "AccountLabel"
        ("id", "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "evaluable", "labeledAt", "sourceKind", "sourceId", "sourceUsername")
      SELECT ti.*, shared_now."labeledAt", ${params.sourceKind}, ${params.sourceId ?? null}, ${params.sourceUsername ?? null}
      FROM to_insert ti
      CROSS JOIN shared_now
      RETURNING *
    ),
    upserted_latest AS (
      INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "evaluable", "labeledAt", "sourceKind", "sourceId", "sourceUsername")
      SELECT ir."accountId", ir."labelDefinitionId", ir."value", ir."confidence", ir."reason", ir."method", ir."ruleVersion", ir."evaluable", shared_now."labeledAt", ${params.sourceKind}, ${params.sourceId ?? null}, ${params.sourceUsername ?? null}
      FROM input_rows ir
      CROSS JOIN shared_now
      WHERE EXISTS (SELECT 1 FROM to_insert ti WHERE ti."id" = ir."id")
      ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE
      SET "value" = EXCLUDED."value", "confidence" = EXCLUDED."confidence", "reason" = EXCLUDED."reason",
          "method" = EXCLUDED."method", "ruleVersion" = EXCLUDED."ruleVersion", "evaluable" = EXCLUDED."evaluable", "labeledAt" = EXCLUDED."labeledAt",
          "sourceKind" = EXCLUDED."sourceKind", "sourceId" = EXCLUDED."sourceId", "sourceUsername" = EXCLUDED."sourceUsername"
      WHERE "AccountLabelLatest"."labeledAt" <= EXCLUDED."labeledAt"
      RETURNING "accountId", "labelDefinitionId"
    )
    SELECT
      ir."id", ir."accountId", ir."labelDefinitionId", ir."value", ir."confidence", ir."reason", ir."method", ir."ruleVersion", ir."evaluable",
      ih."labeledAt",
      (ih."id" IS NOT NULL) AS "historyInserted",
      EXISTS (
        SELECT 1 FROM upserted_latest ul
        WHERE ul."accountId" = ir."accountId" AND ul."labelDefinitionId" = ir."labelDefinitionId"
      ) AS "latestUpserted",
      NOT EXISTS (
        SELECT 1 FROM to_insert ti WHERE ti."id" = ir."id"
      ) AS "semanticNoOp"
    FROM input_rows ir
    LEFT JOIN inserted_history ih ON ih."id" = ir."id"
  `

  const history: AccountLabel[] = []
  for (const row of rows) {
    const { historyInserted, latestUpserted, semanticNoOp, labeledAt, ...rest } = row
    if (!latestUpserted && !semanticNoOp) {
      logger.warn(
        `recordAccountLabelsBulk: AccountLabelLatest upsert guard skipped the write (accountId=${rest.accountId}, labelDefinitionId=${rest.labelDefinitionId})`,
      )
    }
    if (historyInserted && labeledAt) {
      history.push({
        ...rest,
        labeledAt,
        sourceKind: params.sourceKind,
        sourceId: params.sourceId ?? null,
        sourceUsername: params.sourceUsername ?? null,
      })
    }
  }

  return history
}

/**
 * crawl 中のラベル評価結果を記録する。
 * `AccountLabelLatest` の直前の value・ruleVersion・confidence・reason のいずれかと
 * 一致しない場合のみ `AccountLabel` に履歴を追記し、
 * dashboard/アカウント一覧の各クエリが読む `AccountLabelLatest` の該当行は毎回 upsert する
 * (テーブルの設計意図は prisma/schema.prisma の AccountLabelLatest コメントを参照)。
 * 両方の書き込みは SQL 側の `now()` を共有するため、
 * どちらが「現在の値」かで食い違うことはない。
 * Node/app 側のクロックで生成すると、
 * app サーバー間のクロックずれで upsert 側のガードが評価を無音に取りこぼしうる。
 * upsert 側は `labeledAt` の比較でガードしており、
 * この関数を並行して呼ぶ複数の呼び出し元同士が同一アカウントに対して競合しても、
 * 新しい評価が古い評価で上書きされることはない。
 * history の作成と upsert は CTE で連結した1本の SQL 文にまとめており、
 * ネットワークラウンドトリップは1回で済む。
 * `id` は raw INSERT が Prisma クライアント側の `@default(cuid())` を経由しないため、
 * `randomUUID()` で生成しており時系列でソート可能ではない。
 * 同一アカウント・ラベルで `labeledAt` が完全一致する稀なケースのみ id の大小関係が絡むが、
 * そのようなタイの発生自体が稀なため許容する。
 *
 * これに加えて、
 * 同じ crawl run・ログインアカウント・対象アカウント・ルールを 1回だけ claim するため、
 * author phase の永続化後に停止しても再開時に `AccountLabel` の履歴を重複させない。
 * @param prisma - Prisma クライアント
 * @param params - crawl run を含むラベル評価結果
 */
export async function recordCrawlAccountLabel(
  prisma: PrismaClient,
  params: RecordCrawlAccountLabelParams,
): Promise<void> {
  const id = randomUUID()
  const claimId = randomUUID()
  const rows = await prisma.$queryRaw<RecordAccountLabelRow[]>`
    WITH shared_now AS (
      SELECT now() AS "labeledAt"
    ),
    claimed AS (
      INSERT INTO "CrawlAccountLabelRun"
        ("id", "crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion")
      VALUES (${claimId}, ${params.crawlRunId}, ${params.username}, ${params.accountId}, ${params.labelDefinitionId}, ${params.method}, ${params.ruleVersion})
      ON CONFLICT ("crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion") DO NOTHING
      RETURNING "id"
    ),
    previous_latest AS (
      SELECT "value", "ruleVersion", "confidence", "reason", "method", "evaluable"
      FROM "AccountLabelLatest"
      WHERE "accountId" = ${params.accountId} AND "labelDefinitionId" = ${params.labelDefinitionId}
    ),
    inserted_history AS (
      INSERT INTO "AccountLabel"
        ("id", "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "evaluable", "labeledAt", "sourceKind", "sourceId", "sourceUsername")
      SELECT ${id}, ${params.accountId}, ${params.labelDefinitionId}, ${params.result.value}, ${params.result.confidence}, ${params.result.reason}, ${params.method}, ${params.ruleVersion}, ${params.result.evaluable ?? true}, "labeledAt", 'crawl', ${params.crawlRunId}, ${params.username}
      FROM shared_now
      WHERE EXISTS (SELECT 1 FROM claimed)
        AND NOT EXISTS (
          SELECT 1 FROM previous_latest
          WHERE "value" = ${params.result.value} AND "ruleVersion" = ${params.ruleVersion}
            AND "confidence" = ${params.result.confidence} AND "reason" = ${params.result.reason}
            AND "method" = ${params.method} AND "evaluable" = ${params.result.evaluable ?? true}
        )
      RETURNING "id"
    ),
    upserted_latest AS (
      INSERT INTO "AccountLabelLatest"
        ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "evaluable", "labeledAt", "sourceKind", "sourceId", "sourceUsername")
      SELECT ${params.accountId}, ${params.labelDefinitionId}, ${params.result.value}, ${params.result.confidence}, ${params.result.reason}, ${params.method}, ${params.ruleVersion}, ${params.result.evaluable ?? true}, "labeledAt", 'crawl', ${params.crawlRunId}, ${params.username}
      FROM shared_now
      WHERE EXISTS (SELECT 1 FROM claimed)
      ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE
      SET "value" = EXCLUDED."value", "confidence" = EXCLUDED."confidence", "reason" = EXCLUDED."reason",
          "method" = EXCLUDED."method", "ruleVersion" = EXCLUDED."ruleVersion", "evaluable" = EXCLUDED."evaluable", "labeledAt" = EXCLUDED."labeledAt",
          "sourceKind" = EXCLUDED."sourceKind", "sourceId" = EXCLUDED."sourceId", "sourceUsername" = EXCLUDED."sourceUsername"
      WHERE "AccountLabelLatest"."labeledAt" <= EXCLUDED."labeledAt"
      RETURNING "accountId"
    )
    SELECT
      EXISTS (SELECT 1 FROM upserted_latest) AS "latestUpserted"
    FROM claimed
  `
  const row = rows.at(0)
  if (!row) return
  const { latestUpserted } = row
  if (!latestUpserted) {
    logger.warn(
      `recordCrawlAccountLabel: AccountLabelLatest upsert guard skipped the write (accountId=${params.accountId}, labelDefinitionId=${params.labelDefinitionId})`,
    )
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

  await recordAccountLabelsBulk(prisma, {
    accountId: params.accountId,
    labels: claimedLabels,
    sourceKind: 'crawl',
    sourceId: params.crawlRunId,
    sourceUsername: params.username,
  })

  const observation = await prisma.accountClassificationObservation.create({
    data: {
      accountId: params.accountId,
      crawlRunId: params.crawlRunId,
      username: params.username,
      observedAt: new Date(),
      labelCount: claimedLabels.length,
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
