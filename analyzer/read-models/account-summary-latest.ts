import type { PrismaClient } from '../generated/prisma'

/** upsertAccountSummaryLatest の入力。呼び出し元が更新しない component は現在値をそのまま渡す。 */
export interface UpsertAccountSummaryLatestInput {
  accountId: string
  normalizedScreenName: string
  normalizedDisplayName: string
  searchDocument: string
  profileObservedAt: Date
  activeLabelKeys: string[]
  activeLabelCount: number
  lastClassificationChangedAt: Date | null
  classificationObservedAt: Date | null
  activeFindingCount: number
  highestFindingSeverity: string | null
  findingObservedAt: Date | null
}

/**
 * profileObservedAt/classificationObservedAt/findingObservedAt の 3 watermark を
 * 独立に比較し、component ごとに新しい観測だけを反映する。
 * 呼び出し元 (classification refresh・finding refresh・bootstrap) が更新しない
 * component は、その component の現在値をそのまま入力として渡す契約とする。
 * これにより Weekly Review 由来の finding 更新と crawler 由来の classification
 * 更新が同じ行を同時に更新しても、互いの component を巻き戻し合わない。
 * @param prisma - Prisma クライアント
 * @param input - 3 watermark 分のフィールドを含む更新内容
 */
export async function upsertAccountSummaryLatest(
  prisma: PrismaClient,
  input: UpsertAccountSummaryLatestInput,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "AccountSummaryLatest" (
      "accountId", "normalizedScreenName", "normalizedDisplayName", "searchDocument", "profileObservedAt",
      "activeLabelKeys", "activeLabelCount", "lastClassificationChangedAt", "classificationObservedAt",
      "activeFindingCount", "highestFindingSeverity", "findingObservedAt", "updatedAt"
    ) VALUES (
      ${input.accountId}, ${input.normalizedScreenName}, ${input.normalizedDisplayName}, ${input.searchDocument},
      ${input.profileObservedAt}, ${input.activeLabelKeys}, ${input.activeLabelCount},
      ${input.lastClassificationChangedAt}, ${input.classificationObservedAt},
      ${input.activeFindingCount}, ${input.highestFindingSeverity}, ${input.findingObservedAt}, now()
    )
    ON CONFLICT ("accountId") DO UPDATE SET
      "normalizedScreenName" = CASE
        WHEN EXCLUDED."profileObservedAt" >= "AccountSummaryLatest"."profileObservedAt"
        THEN EXCLUDED."normalizedScreenName" ELSE "AccountSummaryLatest"."normalizedScreenName" END,
      "normalizedDisplayName" = CASE
        WHEN EXCLUDED."profileObservedAt" >= "AccountSummaryLatest"."profileObservedAt"
        THEN EXCLUDED."normalizedDisplayName" ELSE "AccountSummaryLatest"."normalizedDisplayName" END,
      "searchDocument" = CASE
        WHEN EXCLUDED."profileObservedAt" >= "AccountSummaryLatest"."profileObservedAt"
        THEN EXCLUDED."searchDocument" ELSE "AccountSummaryLatest"."searchDocument" END,
      "profileObservedAt" = GREATEST(EXCLUDED."profileObservedAt", "AccountSummaryLatest"."profileObservedAt"),
      "activeLabelKeys" = CASE
        WHEN "AccountSummaryLatest"."classificationObservedAt" IS NULL
          OR EXCLUDED."classificationObservedAt" >= "AccountSummaryLatest"."classificationObservedAt"
        THEN EXCLUDED."activeLabelKeys" ELSE "AccountSummaryLatest"."activeLabelKeys" END,
      "activeLabelCount" = CASE
        WHEN "AccountSummaryLatest"."classificationObservedAt" IS NULL
          OR EXCLUDED."classificationObservedAt" >= "AccountSummaryLatest"."classificationObservedAt"
        THEN EXCLUDED."activeLabelCount" ELSE "AccountSummaryLatest"."activeLabelCount" END,
      "lastClassificationChangedAt" = CASE
        WHEN "AccountSummaryLatest"."classificationObservedAt" IS NULL
          OR EXCLUDED."classificationObservedAt" >= "AccountSummaryLatest"."classificationObservedAt"
        THEN EXCLUDED."lastClassificationChangedAt" ELSE "AccountSummaryLatest"."lastClassificationChangedAt" END,
      "classificationObservedAt" = CASE
        WHEN "AccountSummaryLatest"."classificationObservedAt" IS NULL THEN EXCLUDED."classificationObservedAt"
        ELSE GREATEST(EXCLUDED."classificationObservedAt", "AccountSummaryLatest"."classificationObservedAt") END,
      "activeFindingCount" = CASE
        WHEN "AccountSummaryLatest"."findingObservedAt" IS NULL
          OR EXCLUDED."findingObservedAt" >= "AccountSummaryLatest"."findingObservedAt"
        THEN EXCLUDED."activeFindingCount" ELSE "AccountSummaryLatest"."activeFindingCount" END,
      "highestFindingSeverity" = CASE
        WHEN "AccountSummaryLatest"."findingObservedAt" IS NULL
          OR EXCLUDED."findingObservedAt" >= "AccountSummaryLatest"."findingObservedAt"
        THEN EXCLUDED."highestFindingSeverity" ELSE "AccountSummaryLatest"."highestFindingSeverity" END,
      "findingObservedAt" = CASE
        WHEN "AccountSummaryLatest"."findingObservedAt" IS NULL THEN EXCLUDED."findingObservedAt"
        ELSE GREATEST(EXCLUDED."findingObservedAt", "AccountSummaryLatest"."findingObservedAt") END,
      "updatedAt" = now()
  `
}

/** upsertAccountClassificationLatest の入力行。 */
export interface AccountClassificationLatestRow {
  accountId: string
  labelDefinitionId: string
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  observedAt: Date
  sourceObservationId: string | null
}

/**
 * `(accountId, labelDefinitionId)` 単位で `observedAt` の単調性を課して upsert する。
 * bootstrap (古い baseline) と通常 Crawler (新しい観測) が並行しても、
 * 後から commit した古い観測が新しい観測を巻き戻さない。
 * @param prisma - Prisma クライアント
 * @param rows - 対象アカウントの classification 行一覧
 */
export async function upsertAccountClassificationLatest(
  prisma: PrismaClient,
  rows: AccountClassificationLatestRow[],
): Promise<void> {
  if (rows.length === 0) return
  await prisma.$executeRaw`
    INSERT INTO "AccountClassificationLatest" (
      "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion",
      "observedAt", "sourceObservationId"
    )
    SELECT * FROM UNNEST(
      ${rows.map((row) => row.accountId)}::text[],
      ${rows.map((row) => row.labelDefinitionId)}::text[],
      ${rows.map((row) => row.value)}::boolean[],
      ${rows.map((row) => row.confidence)}::double precision[],
      ${rows.map((row) => row.reason)}::text[],
      ${rows.map((row) => row.method)}::text[],
      ${rows.map((row) => row.ruleVersion)}::text[],
      ${rows.map((row) => row.observedAt)}::timestamp[],
      ${rows.map((row) => row.sourceObservationId)}::text[]
    ) AS u(
      "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion",
      "observedAt", "sourceObservationId"
    )
    ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE SET
      "value" = EXCLUDED."value", "confidence" = EXCLUDED."confidence", "reason" = EXCLUDED."reason",
      "method" = EXCLUDED."method", "ruleVersion" = EXCLUDED."ruleVersion", "observedAt" = EXCLUDED."observedAt",
      "sourceObservationId" = EXCLUDED."sourceObservationId"
    WHERE "AccountClassificationLatest"."observedAt" <= EXCLUDED."observedAt"
  `
}

const ACCOUNT_SUMMARY_LATEST_MODEL_KEY = 'account_summary_latest'

/**
 * `AccountSummaryLatest`/`AccountClassificationLatest` の更新が成功した直後に呼ぶ。
 * generation を持たないためレイアウトは `publishGeneration` と異なるが、
 * `lastSuccessAt`/`sourceWatermarkAt`/`status: 'healthy'` を記録する点は同じであり、
 * 経過時間からの delayed/stale 判定 (`refreshReadModelFreshness`) が
 * 汎用的にこの行も拾えるようにする。
 * @param prisma - Prisma クライアント
 * @param sourceWatermarkAt - この更新が反映した観測時刻
 */
export async function touchAccountSummaryLatestState(
  prisma: PrismaClient,
  sourceWatermarkAt: Date,
): Promise<void> {
  await prisma.readModelState.upsert({
    where: { modelKey: ACCOUNT_SUMMARY_LATEST_MODEL_KEY },
    create: {
      modelKey: ACCOUNT_SUMMARY_LATEST_MODEL_KEY,
      schemaVersion: 1,
      status: 'healthy',
      sourceWatermarkAt,
      lastSuccessAt: new Date(),
    },
    update: {
      status: 'healthy',
      sourceWatermarkAt,
      lastSuccessAt: new Date(),
    },
  })
}

/**
 * `processAccountSummaryRefresh`/`processAccountFindingRefresh`/
 * `processAccountSummaryBootstrap` が例外を投げて終了する直前に呼ぶ。
 * `publishGeneration` の失敗パスと同様、`status: 'failed'` は
 * 経過時間による delayed/stale 判定で上書きされない (`refreshReadModelFreshness`
 * 側が `status === 'failed'` の行をスキップする設計を踏襲する)。
 * @param prisma - Prisma クライアント
 * @param errorSummary - 記録するエラー概要
 */
export async function markAccountSummaryLatestFailed(
  prisma: PrismaClient,
  errorSummary: string,
): Promise<void> {
  await prisma.readModelState.upsert({
    where: { modelKey: ACCOUNT_SUMMARY_LATEST_MODEL_KEY },
    create: {
      modelKey: ACCOUNT_SUMMARY_LATEST_MODEL_KEY,
      schemaVersion: 1,
      status: 'failed',
      lastFailureAt: new Date(),
      errorSummary,
    },
    update: {
      status: 'failed',
      lastFailureAt: new Date(),
      errorSummary,
    },
  })
}
