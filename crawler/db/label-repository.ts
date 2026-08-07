import { randomUUID } from 'node:crypto'
import { Logger } from '@book000/node-utils'
import type { AccountLabel, LabelDefinition, PrismaClient } from '../generated/prisma'
import type { LabelRule, LabelRuleResult } from '../labels/types'

const logger = Logger.configure('label-repository')

export interface LabelDefinitionInput {
  key: string
  description: string
}

export async function ensureLabelDefinition(
  prisma: PrismaClient,
  input: LabelDefinitionInput,
): Promise<LabelDefinition> {
  return prisma.labelDefinition.upsert({
    where: { key: input.key },
    create: input,
    update: { description: input.description },
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
  labeledAt: Date | null
  historyInserted: boolean
  latestUpserted: boolean
}

/**
 * 1アカウント分の評価結果をまとめて記録する: ラベルごとに `$queryRaw` を逐次発行する代わりに、
 * 列単位の配列を `UNNEST` で展開し、
 * `AccountLabel` への INSERT と `AccountLabelLatest` への UPSERT を1ラウンドトリップにまとめる。
 * UPSERT ガードの意味論は `recordCrawlAccountLabel` と同じ。
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

  const rows = await prisma.$queryRaw<RecordAccountLabelsBulkRow[]>`
    WITH shared_now AS (
      SELECT now() AS "labeledAt"
    ),
    input_rows AS (
      SELECT * FROM UNNEST(${ids}::text[], ${accountIds}::text[], ${labelDefinitionIds}::text[], ${values}::boolean[], ${confidences}::double precision[], ${reasons}::text[], ${methods}::text[], ${ruleVersions}::text[])
        AS u("id", "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion")
    ),
    to_insert AS (
      SELECT ir.*
      FROM input_rows ir
      LEFT JOIN "AccountLabelLatest" al
        ON al."accountId" = ir."accountId" AND al."labelDefinitionId" = ir."labelDefinitionId"
      WHERE al."accountId" IS NULL
         OR al."value" IS DISTINCT FROM ir."value"
         OR al."ruleVersion" IS DISTINCT FROM ir."ruleVersion"
    ),
    inserted_history AS (
      INSERT INTO "AccountLabel"
        ("id", "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt")
      SELECT ti.*, shared_now."labeledAt"
      FROM to_insert ti
      CROSS JOIN shared_now
      RETURNING *
    ),
    upserted_latest AS (
      INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt")
      SELECT ir."accountId", ir."labelDefinitionId", ir."value", ir."confidence", ir."reason", ir."method", ir."ruleVersion", shared_now."labeledAt"
      FROM input_rows ir
      CROSS JOIN shared_now
      ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE
      SET "value" = EXCLUDED."value", "confidence" = EXCLUDED."confidence", "reason" = EXCLUDED."reason",
          "method" = EXCLUDED."method", "ruleVersion" = EXCLUDED."ruleVersion", "labeledAt" = EXCLUDED."labeledAt"
      WHERE "AccountLabelLatest"."labeledAt" <= EXCLUDED."labeledAt"
      RETURNING "accountId", "labelDefinitionId"
    )
    SELECT
      ir."id", ir."accountId", ir."labelDefinitionId", ir."value", ir."confidence", ir."reason", ir."method", ir."ruleVersion",
      ih."labeledAt",
      (ih."id" IS NOT NULL) AS "historyInserted",
      EXISTS (
        SELECT 1 FROM upserted_latest ul
        WHERE ul."accountId" = ir."accountId" AND ul."labelDefinitionId" = ir."labelDefinitionId"
      ) AS "latestUpserted"
    FROM input_rows ir
    LEFT JOIN inserted_history ih ON ih."id" = ir."id"
  `

  const history: AccountLabel[] = []
  for (const row of rows) {
    const { historyInserted, latestUpserted, labeledAt, ...rest } = row
    if (!latestUpserted) {
      logger.warn(
        `recordAccountLabelsBulk: AccountLabelLatest upsert guard skipped the write (accountId=${rest.accountId}, labelDefinitionId=${rest.labelDefinitionId})`,
      )
    }
    if (historyInserted && labeledAt) {
      // このバルク経路は INSERT 列に sourceKind/sourceId/sourceUsername を含めず、
      // スキーマ側のデフォルト ("legacy" / null / null) に委ねているため、
      // 返却するオブジェクトもそれに合わせる。
      history.push({ ...rest, labeledAt, sourceKind: 'legacy', sourceId: null, sourceUsername: null })
    }
  }

  return history
}

/**
 * crawl 中のラベル評価結果を記録する。
 * `AccountLabelLatest` の直前の値・ruleVersion と一致しない場合のみ `AccountLabel` に履歴を追記し、
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
      SELECT "value", "ruleVersion"
      FROM "AccountLabelLatest"
      WHERE "accountId" = ${params.accountId} AND "labelDefinitionId" = ${params.labelDefinitionId}
    ),
    inserted_history AS (
      INSERT INTO "AccountLabel"
        ("id", "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt")
      SELECT ${id}, ${params.accountId}, ${params.labelDefinitionId}, ${params.result.value}, ${params.result.confidence}, ${params.result.reason}, ${params.method}, ${params.ruleVersion}, "labeledAt"
      FROM shared_now
      WHERE EXISTS (SELECT 1 FROM claimed)
        AND NOT EXISTS (
          SELECT 1 FROM previous_latest
          WHERE "value" = ${params.result.value} AND "ruleVersion" = ${params.ruleVersion}
        )
      RETURNING "id"
    ),
    upserted_latest AS (
      INSERT INTO "AccountLabelLatest"
        ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt")
      SELECT ${params.accountId}, ${params.labelDefinitionId}, ${params.result.value}, ${params.result.confidence}, ${params.result.reason}, ${params.method}, ${params.ruleVersion}, "labeledAt"
      FROM shared_now
      WHERE EXISTS (SELECT 1 FROM claimed)
      ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE
      SET "value" = EXCLUDED."value", "confidence" = EXCLUDED."confidence", "reason" = EXCLUDED."reason",
          "method" = EXCLUDED."method", "ruleVersion" = EXCLUDED."ruleVersion", "labeledAt" = EXCLUDED."labeledAt"
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
