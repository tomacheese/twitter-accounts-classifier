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
 * `activeLabelKeys` が行ごとに長さの異なる配列のため `UNNEST` ではなく
 * `jsonb_to_recordset` で複数行をまとめて渡す。bootstrap の 1 chunk に含まれる
 * 全 Account 分を 1 回の呼び出しにまとめられるようにし、chunk 内で Account 数分の
 * 往復が発生しないようにする。
 * @param prisma - Prisma クライアント
 * @param rows - 3 watermark 分のフィールドを含む更新内容の一覧
 */
export async function upsertAccountSummaryLatest(
  prisma: PrismaClient,
  rows: UpsertAccountSummaryLatestInput[],
): Promise<void> {
  if (rows.length === 0) return
  await prisma.$executeRaw`
    INSERT INTO "AccountSummaryLatest" (
      "accountId", "normalizedScreenName", "normalizedDisplayName", "searchDocument", "profileObservedAt",
      "activeLabelKeys", "activeLabelCount", "lastClassificationChangedAt", "classificationObservedAt",
      "activeFindingCount", "highestFindingSeverity", "findingObservedAt", "updatedAt"
    )
    SELECT
      "accountId", "normalizedScreenName", "normalizedDisplayName", "searchDocument", "profileObservedAt",
      "activeLabelKeys", "activeLabelCount", "lastClassificationChangedAt", "classificationObservedAt",
      "activeFindingCount", "highestFindingSeverity", "findingObservedAt", now()
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS u(
      "accountId" text, "normalizedScreenName" text, "normalizedDisplayName" text, "searchDocument" text,
      "profileObservedAt" timestamp, "activeLabelKeys" text[], "activeLabelCount" int,
      "lastClassificationChangedAt" timestamp, "classificationObservedAt" timestamp,
      "activeFindingCount" int, "highestFindingSeverity" text, "findingObservedAt" timestamp
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
  evaluable: boolean
  labeledAt: Date | null
}

/**
 * `(accountId, labelDefinitionId)` 単位で 2 系統の watermark を独立に比較して upsert する。
 * `value`/`confidence`/`reason`/`method`/`ruleVersion`/`evaluable`/`labeledAt` (label の
 * 意味的な中身一式) は `labeledAt` を watermark に同一 row 単位・原子的に更新し、
 * `observedAt`/`sourceObservationId` (この行を最後に書いた analyzer observation を指す
 * メタデータ) は `observedAt` を watermark に独立更新する。
 * これらを同じ watermark で一括更新しない (`value` 等だけ `observedAt` 基準にする)
 * 分割は避ける。bootstrap がより新しい `labeledAt` の label row を読んで書き込んだ後に
 * live refresh がより古い `labeledAt` (だが新しい `observedAt`) の書き込みで再上書きしても、
 * `value` が新しい `labeledAt` 由来のまま `labeledAt` だけ古い書き込み由来になる、
 * といった由来の異なる label の混在を避けるためである。
 * @param prisma - Prisma クライアント
 * @param rows - 対象アカウントの classification 行一覧
 */
export async function upsertAccountClassificationLatest(
  prisma: PrismaClient,
  rows: AccountClassificationLatestRow[],
): Promise<void> {
  if (rows.length === 0) return
  // 同一トランザクション内で labelDefinitionId ごとに複数回発火する
  // FOR EACH ROW トリガーのロック取得順序を常に昇順に固定し、
  // 呼び出し元間でのデッドロックを避ける (compaction も同じ昇順で処理する)。
  // ロケール依存の localeCompare は環境によって順序が変わり得るため使わない。
  const sortedRows = rows.toSorted((a, b) =>
    a.labelDefinitionId < b.labelDefinitionId
      ? -1
      : a.labelDefinitionId > b.labelDefinitionId
        ? 1
        : 0,
  )
  await prisma.$executeRaw`
    INSERT INTO "AccountClassificationLatest" (
      "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion",
      "observedAt", "sourceObservationId", "evaluable", "labeledAt"
    )
    SELECT * FROM UNNEST(
      ${sortedRows.map((row) => row.accountId)}::text[],
      ${sortedRows.map((row) => row.labelDefinitionId)}::text[],
      ${sortedRows.map((row) => row.value)}::boolean[],
      ${sortedRows.map((row) => row.confidence)}::double precision[],
      ${sortedRows.map((row) => row.reason)}::text[],
      ${sortedRows.map((row) => row.method)}::text[],
      ${sortedRows.map((row) => row.ruleVersion)}::text[],
      ${sortedRows.map((row) => row.observedAt)}::timestamp[],
      ${sortedRows.map((row) => row.sourceObservationId)}::text[],
      ${sortedRows.map((row) => row.evaluable)}::boolean[],
      -- legacy bootstrap は labeledAt を全行 null で渡す。全要素が null の配列は
      -- driver 側で integer[] と推定され timestamp[] への直接 cast が失敗するため、
      -- text[] を経由させて要素型推定に依存しないようにする。
      ${sortedRows.map((row) => row.labeledAt)}::text[]::timestamp[]
    ) AS u(
      "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion",
      "observedAt", "sourceObservationId", "evaluable", "labeledAt"
    )
    ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE SET
      "value" = CASE
        WHEN "AccountClassificationLatest"."labeledAt" IS NULL
          OR EXCLUDED."labeledAt" >= "AccountClassificationLatest"."labeledAt"
        THEN EXCLUDED."value" ELSE "AccountClassificationLatest"."value" END,
      "confidence" = CASE
        WHEN "AccountClassificationLatest"."labeledAt" IS NULL
          OR EXCLUDED."labeledAt" >= "AccountClassificationLatest"."labeledAt"
        THEN EXCLUDED."confidence" ELSE "AccountClassificationLatest"."confidence" END,
      "reason" = CASE
        WHEN "AccountClassificationLatest"."labeledAt" IS NULL
          OR EXCLUDED."labeledAt" >= "AccountClassificationLatest"."labeledAt"
        THEN EXCLUDED."reason" ELSE "AccountClassificationLatest"."reason" END,
      "method" = CASE
        WHEN "AccountClassificationLatest"."labeledAt" IS NULL
          OR EXCLUDED."labeledAt" >= "AccountClassificationLatest"."labeledAt"
        THEN EXCLUDED."method" ELSE "AccountClassificationLatest"."method" END,
      "ruleVersion" = CASE
        WHEN "AccountClassificationLatest"."labeledAt" IS NULL
          OR EXCLUDED."labeledAt" >= "AccountClassificationLatest"."labeledAt"
        THEN EXCLUDED."ruleVersion" ELSE "AccountClassificationLatest"."ruleVersion" END,
      "evaluable" = CASE
        WHEN "AccountClassificationLatest"."labeledAt" IS NULL
          OR EXCLUDED."labeledAt" >= "AccountClassificationLatest"."labeledAt"
        THEN EXCLUDED."evaluable" ELSE "AccountClassificationLatest"."evaluable" END,
      "labeledAt" = GREATEST(EXCLUDED."labeledAt", "AccountClassificationLatest"."labeledAt"),
      "sourceObservationId" = CASE
        WHEN EXCLUDED."observedAt" >= "AccountClassificationLatest"."observedAt"
        THEN EXCLUDED."sourceObservationId" ELSE "AccountClassificationLatest"."sourceObservationId" END,
      "observedAt" = GREATEST(EXCLUDED."observedAt", "AccountClassificationLatest"."observedAt")
  `
}

const ACCOUNT_SUMMARY_LATEST_MODEL_KEY = 'account_summary_latest'

/**
 * `AccountSummaryLatest`/`AccountClassificationLatest` の更新が成功した直後に呼ぶ。
 * generation を持たないためレイアウトは `publishGeneration` と異なるが、
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
      errorCode: null,
      errorSummary: null,
    },
    update: {
      status: 'healthy',
      sourceWatermarkAt,
      lastSuccessAt: new Date(),
      errorCode: null,
      errorSummary: null,
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
