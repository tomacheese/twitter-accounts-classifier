import type { PrismaClient } from '../generated/prisma'
import type { BlockRuleConfig } from '../config/load-config'

/**
 * ブロック候補として選定されたアカウント1件分の情報。
 */
export interface BlockCandidate {
  accountId: string
  labelDefinitionId: string
  confidence: number
}

/**
 * `block_enabled` なアカウント 1 件分のブロック候補を選定する。
 *
 * `AccountLabelLatest` は確信度を保持していないため、`relabel.ts` の
 * `loadLatestRuleVersions` と同じ `DISTINCT ON` パターンで `AccountLabel` から
 * 各 (account, label) の最新確信度を導出し、そこから `confidenceThreshold` 以上のものへ絞り込む。
 * 1 アカウントが複数の対象ラベルに合致する場合は、確信度が最も高いラベルのみを根拠として残す
 * (`DISTINCT ON ("accountId")` で確信度降順の先頭行を残すことで実現する)。
 * @param prisma - Prisma クライアント
 * @param blockerId - このブロック実行を行うログインアカウントの `Account.id`
 * @param rule - 適用するブロックルール (対象ラベル・確信度閾値)
 * @param maxCount - 返す候補の最大件数。確信度が高い候補を優先して残すため降順ソート後にカットする
 * @returns 確信度降順に並んだブロック候補
 */
export async function selectBlockCandidates(
  prisma: PrismaClient,
  blockerId: string,
  rule: BlockRuleConfig,
  maxCount: number,
): Promise<BlockCandidate[]> {
  const rows = await prisma.$queryRaw<BlockCandidate[]>`
    WITH latest_confidence AS (
      SELECT DISTINCT ON ("accountId", "labelDefinitionId")
        "accountId", "labelDefinitionId", "confidence"
      FROM "AccountLabel"
      ORDER BY "accountId", "labelDefinitionId", "labeledAt" DESC, "id" DESC
    ),
    best_label_per_account AS (
      SELECT DISTINCT ON (lc."accountId")
        lc."accountId", lc."labelDefinitionId", lc."confidence"
      FROM latest_confidence lc
      JOIN "AccountLabelLatest" all_latest
        ON all_latest."accountId" = lc."accountId"
        AND all_latest."labelDefinitionId" = lc."labelDefinitionId"
      JOIN "LabelDefinition" ld ON ld.id = lc."labelDefinitionId"
      WHERE all_latest.value = true
        AND ld.key = ANY(${rule.targetLabels})
        AND lc."confidence" >= ${rule.confidenceThreshold}
        AND lc."accountId" != ${blockerId}
      ORDER BY lc."accountId", lc."confidence" DESC
    )
    SELECT b."accountId", b."labelDefinitionId", b."confidence"
    FROM best_label_per_account b
    WHERE NOT EXISTS (
      SELECT 1 FROM "Block" bl
      WHERE bl."blockerId" = ${blockerId} AND bl."blockedId" = b."accountId"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "BlockAction" ba
      WHERE ba."blockerId" = ${blockerId}
        AND ba."blockedId" = b."accountId"
        AND ba."result" = 'success'
    )
    AND NOT EXISTS (
      SELECT 1 FROM "Follow" f
      WHERE (f."followerId" = ${blockerId} AND f."followeeId" = b."accountId")
         OR (f."followerId" = b."accountId" AND f."followeeId" = ${blockerId})
    )
    ORDER BY b."confidence" DESC
    LIMIT ${maxCount}
  `
  return rows
}
