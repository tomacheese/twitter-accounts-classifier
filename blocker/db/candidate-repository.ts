import type { PrismaClient } from '../generated/prisma'
import type { BlockRuleConfig } from '../config/load-config'

// reply_farming は recent timeline 取得修正 (#267) によって判定入力が大きく変わり、
// 現行閾値では正規の高頻度サポート/挨拶アカウントを誤検知し得る。
// generic_reply_farming/contextual_reply_marketing は shadow 観測専用で、精度レビュー前に block へ昇格させない。
// いずれも明示的なコード変更・レビューなしには block 候補へ流さない fail-closed policy とする。
const NON_BLOCKING_LABEL_KEYS = new Set([
  'reply_farming',
  'generic_reply_farming',
  'contextual_reply_marketing',
])

/**
 * ブロック候補として選定されたアカウント1件分の情報。
 */
export interface BlockCandidate {
  accountId: string
  labelDefinitionId: number
  confidence: number
}

/**
 * true のラベルと confidence は `AccountActiveLabel` に保持されているため、
 * 評価状態の全体を持つ `AccountLabelState` は参照しない。対象ラベル (`rule.targetLabels`) と
 * confidence 閾値で `AccountActiveLabel` を直接絞り込み、アカウントごとに最も高い
 * confidence のラベルだけを候補判定へ渡す。
 * @param prisma - Prisma クライアント
 * @param blockerId - このブロック実行を行うログインアカウントの `Account.id`
 * @param rule - 適用するブロックルール (ラベルごとの確信度閾値)
 * @param maxCount - 返す候補の最大件数。確信度が高い候補を優先して残すため降順ソート後にカットする
 * @param maxAttempts - `remoteSkipCount` がこの値以上の target を terminal skip として除外する
 * @param cooldownSeconds - `lastRemoteSkippedAt` からこの秒数が経過するまで再試行対象から除外する
 * @returns 確信度降順に並んだブロック候補
 */
export async function selectBlockCandidates(
  prisma: PrismaClient,
  blockerId: string,
  rule: BlockRuleConfig,
  maxCount: number,
  maxAttempts: number,
  cooldownSeconds: number,
): Promise<BlockCandidate[]> {
  const blockEligibleTargets = rule.targetLabels.filter(
    (target) => !NON_BLOCKING_LABEL_KEYS.has(target.label),
  )
  if (blockEligibleTargets.length === 0) return []

  const labels = blockEligibleTargets.map((target) => target.label)
  const thresholds = blockEligibleTargets.map((target) => target.confidenceThreshold)
  const rows = await prisma.$queryRaw<BlockCandidate[]>`
    WITH rule_thresholds AS (
      SELECT * FROM unnest(${labels}::text[], ${thresholds}::float8[]) AS t(label_key, threshold)
    ),
    relevant_labels AS (
      SELECT ld.id, ld."currentRuleVersionNo", rt.threshold
      FROM "LabelDefinition" ld
      JOIN rule_thresholds rt ON rt.label_key = ld.key
    ),
    best_label_per_account AS (
      SELECT DISTINCT ON (active."accountId")
        active."accountId",
        active."labelDefinitionId",
        active."confidence"
      FROM "AccountActiveLabel" active
      JOIN relevant_labels rl ON rl.id = active."labelDefinitionId"
      -- ruleVersionNo が現行と一致しない行は stale とみなし候補から除外する。
      -- 版を一斉に上げた直後は、relabel が追いつくまで候補が一時的にゼロになり得る。
      WHERE active."confidence" >= rl.threshold
        AND active."ruleVersionNo" = rl."currentRuleVersionNo"
        AND active."accountId" != ${blockerId}::bigint
      ORDER BY active."accountId", active."confidence" DESC
    )
    SELECT b."accountId"::text AS "accountId", b."labelDefinitionId", b."confidence"
    FROM best_label_per_account b
    WHERE NOT EXISTS (
      SELECT 1 FROM "Block" bl
      WHERE bl."blockerId" = ${blockerId}::bigint AND bl."blockedId" = b."accountId"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "BlockAction" ba
      WHERE ba."blockerId" = ${blockerId}::bigint
        AND ba."blockedId" = b."accountId"
        AND ba."result" = 'success'
    )
    AND NOT EXISTS (
      SELECT 1 FROM "Follow" f
      WHERE (f."followerId" = ${blockerId}::bigint AND f."followeeId" = b."accountId")
         OR (f."followerId" = b."accountId" AND f."followeeId" = ${blockerId}::bigint)
    )
    AND NOT EXISTS (
      SELECT 1 FROM "BlockOutboxEntry" oe
      WHERE oe."blockerId" = ${blockerId}::bigint
        AND oe."blockedId" = b."accountId"
        AND (
          oe."status" IN ('pending_remote', 'remote_succeeded')
          OR (
            oe."status" = 'remote_skipped'
            AND (
              oe."remoteSkipCount" >= ${maxAttempts}
              OR oe."lastRemoteSkippedAt" + (${cooldownSeconds}::int * interval '1 second') > now()
            )
          )
        )
    )
    ORDER BY b."confidence" DESC
    LIMIT ${maxCount}
  `
  return rows
}
