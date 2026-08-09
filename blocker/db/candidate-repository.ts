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
 * `AccountLabelLatest` は確信度を保持していないため、`AccountLabel` の履歴から確信度を
 * 導出する必要がある。ただし `prisma/schema.prisma` が `AccountLabel` について警告している
 * とおり、この履歴テーブルは際限なく増え続けるため、`relabel.ts` の
 * `loadLatestRuleVersions` のように無条件で全件を `DISTINCT ON` すると本番の応答時間を
 * 守れない。ここでは対象ラベル (`rule.targetLabels`) に絞った `relevant_labels` を先に
 * 求め、それで `AccountLabel` 側を絞り込むことでスキャン範囲を対象ラベル関連の行のみに限定する。
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
    latest_confidence AS (
      SELECT DISTINCT ON ("accountId", "labelDefinitionId")
        "accountId", "labelDefinitionId", "confidence"
      FROM "AccountLabel"
      WHERE "labelDefinitionId" IN (SELECT id FROM relevant_labels)
      ORDER BY "accountId", "labelDefinitionId", "labeledAt" DESC, "id" DESC
    ),
    best_label_per_account AS (
      SELECT DISTINCT ON (lc."accountId")
        lc."accountId", lc."labelDefinitionId", lc."confidence"
      FROM latest_confidence lc
      JOIN relevant_labels rl ON rl.id = lc."labelDefinitionId"
      JOIN "AccountLabelLatest" all_latest
        ON all_latest."accountId" = lc."accountId"
        AND all_latest."labelDefinitionId" = lc."labelDefinitionId"
      WHERE all_latest.value = true
        AND lc."confidence" >= rl.threshold
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
