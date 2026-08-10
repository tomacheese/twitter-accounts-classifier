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
 * 最新ラベル値と confidence は `AccountLabelLatest` に保持されているため、
 * 増え続ける `AccountLabel` 履歴は参照しない。対象ラベル (`rule.targetLabels`) と
 * confidence 閾値で `AccountLabelLatest` を直接絞り込み、アカウントごとに最も高い
 * confidence のラベルだけを候補判定へ渡す。
 * @param prisma - Prisma クライアント
 * @param blockerId - このブロック実行を行うログインアカウントの `Account.id`
 * @param rule - 適用するブロックルール (ラベルごとの確信度閾値)
 * @param maxCount - 返す候補の最大件数。確信度が高い候補を優先して残すため降順ソート後にカットする
 * @returns 確信度降順に並んだブロック候補
 */
export async function selectBlockCandidates(
  prisma: PrismaClient,
  blockerId: string,
  rule: BlockRuleConfig,
  maxCount: number,
): Promise<BlockCandidate[]> {
  const labels = rule.targetLabels.map((target) => target.label)
  const thresholds = rule.targetLabels.map((target) => target.confidenceThreshold)
  const rows = await prisma.$queryRaw<BlockCandidate[]>`
    WITH rule_thresholds AS (
      SELECT * FROM unnest(${labels}::text[], ${thresholds}::float8[]) AS t(label_key, threshold)
    ),
    relevant_labels AS (
      SELECT ld.id, rt.threshold
      FROM "LabelDefinition" ld
      JOIN rule_thresholds rt ON rt.label_key = ld.key
    ),
    best_label_per_account AS (
      SELECT DISTINCT ON (all_latest."accountId")
        all_latest."accountId",
        all_latest."labelDefinitionId",
        all_latest."confidence"
      FROM "AccountLabelLatest" all_latest
      JOIN relevant_labels rl ON rl.id = all_latest."labelDefinitionId"
      WHERE all_latest."value" = true
        AND all_latest."confidence" >= rl.threshold
        AND all_latest."accountId" != ${blockerId}
      ORDER BY all_latest."accountId", all_latest."confidence" DESC
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
    AND NOT EXISTS (
      SELECT 1 FROM "BlockOutboxEntry" oe
      WHERE oe."blockerId" = ${blockerId}
        AND oe."blockedId" = b."accountId"
        AND oe."status" IN ('pending_remote', 'remote_succeeded')
    )
    ORDER BY b."confidence" DESC
    LIMIT ${maxCount}
  `
  return rows
}
