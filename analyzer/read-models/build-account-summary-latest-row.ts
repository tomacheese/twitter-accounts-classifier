import type { PrismaClient } from '../generated/prisma'

/** watermark 時点でのラベル値 1 件。 */
export interface LabelAtWatermark {
  accountId: string
  labelDefinitionId: string
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  labeledAt: Date
}

/**
 * 1 Account 分のラベル値を `AccountLabel` 履歴から watermark 時点で復元する。
 * `AccountLabelLatest` は常に最新値のため、bootstrap のような過去時点の
 * 復元には使えない。
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント
 * @param sourceWatermarkAt - 復元する基準時刻
 * @returns watermark 時点で有効だったラベル値一覧
 */
export async function findLabelsAtWatermarkForAccount(
  prisma: PrismaClient,
  accountId: string,
  sourceWatermarkAt: Date,
): Promise<LabelAtWatermark[]> {
  return prisma.$queryRaw<LabelAtWatermark[]>`
    SELECT DISTINCT ON ("labelDefinitionId")
      "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt"
    FROM "AccountLabel"
    WHERE "accountId" = ${accountId} AND "labeledAt" <= ${sourceWatermarkAt}
    ORDER BY "labelDefinitionId", "labeledAt" DESC, "id" DESC
  `
}

/**
 * 1 Account 分の「直前のラベル値」を `AccountLabel` 履歴から watermark 時点で復元する。
 * `AccountLabelChange` の生成に使う。`findLabelsAtWatermarkForAccount` が返す
 * 最新行ではなく、その 1 つ前の履歴行を返す。
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント
 * @param sourceWatermarkAt - 復元する基準時刻
 * @returns labelDefinitionId ごとの直前のラベル値
 */
export async function findPreviousLabelAtWatermarkForAccount(
  prisma: PrismaClient,
  accountId: string,
  sourceWatermarkAt: Date,
): Promise<LabelAtWatermark[]> {
  return prisma.$queryRaw<LabelAtWatermark[]>`
    SELECT "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt"
    FROM (
      SELECT "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt",
        ROW_NUMBER() OVER (
          PARTITION BY "labelDefinitionId"
          ORDER BY "labeledAt" DESC, "id" DESC
        ) AS rn
      FROM "AccountLabel"
      WHERE "accountId" = ${accountId} AND "labeledAt" <= ${sourceWatermarkAt}
    ) ranked
    WHERE rn = 2
  `
}

/** watermark 時点で active だった Finding 1 件。 */
export interface ActiveFindingAtWatermark {
  severity: string
}

const OPEN_STATE_TRANSITIONS = new Set(['active', 'recurring', 'new_episode'])

/**
 * 1 Account 分の active Finding を `ReviewFindingOccurrence` から watermark 時点で復元する。
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント
 * @param sourceWatermarkAt - 復元する基準時刻
 * @returns watermark 時点で active だった Finding の severity 一覧
 */
export async function findActiveFindingsAtWatermarkForAccount(
  prisma: PrismaClient,
  accountId: string,
  sourceWatermarkAt: Date,
): Promise<ActiveFindingAtWatermark[]> {
  const rows = await prisma.$queryRaw<{ severity: string; stateTransition: string }[]>`
    SELECT DISTINCT ON (o."findingId") o."severity", o."stateTransition"
    FROM "ReviewFindingOccurrence" o
    JOIN "ReviewFinding" f ON f.id = o."findingId"
    WHERE f."primaryScopeType" = 'account' AND f."primaryScopeId" = ${accountId}
      AND o."sourceObservedAt" <= ${sourceWatermarkAt}
    ORDER BY o."findingId", o."sourceObservedAt" DESC, o.id DESC
  `
  return rows
    .filter((row) => OPEN_STATE_TRANSITIONS.has(row.stateTransition))
    .map((row) => ({ severity: row.severity }))
}
