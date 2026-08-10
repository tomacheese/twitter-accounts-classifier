import { Prisma, type PrismaClient } from '../generated/prisma'

/**
 * あるアカウントのフォロー先・フォロワーにおける、特定ラベルの既存付与状況。
 * `followeeLabeledCount`/`followeeTotalCount` はこのアカウントのフォロー先における、
 * 該当ラベルが true のアカウント数／AccountLabelLatest 行を持つアカウント総数。
 * `followerLabeledCount`/`followerTotalCount` はフォロワー側で同じ集計を行ったもの。
 * 比率ではなく生の件数を返し、閾値判断は呼び出し側に委ねる。
 */
export interface FollowGraphLabelSignal {
  followeeLabeledCount: number
  followeeTotalCount: number
  followerLabeledCount: number
  followerTotalCount: number
}

export interface FollowGraphLabelIndex {
  /**
   * @param accountId - シグナルを読み出す対象アカウント
   * @returns ラベルキーから `FollowGraphLabelSignal` へのマップ。該当データが無い場合は空オブジェクト
   */
  signalsFor(accountId: string): Record<string, FollowGraphLabelSignal>
}

interface AggregateRow {
  accountId: string
  labelDefinitionId: string
  labeledCount: number
  totalCount: number
}

/**
 * フォロー先方向は `Follow` と `LabelingFollowSample` の両方を、
 * フォロワー方向は `Follow` を、それぞれ `AccountLabelLatest` と突き合わせる集約クエリで、
 * アカウント単位のグラフ探索を行わずにラベルごとの既存付与状況を組み立てる。
 * 参照するのは今回の実行が始まる前に永続化済みの `AccountLabelLatest` の値のみであり、
 * 今回の実行中に確定した新しいラベルは反映しない (呼び出し元がこの関数を各実行の先頭で1回だけ呼ぶ前提のため)。
 * @param prisma - 問い合わせに使う Prisma クライアント
 * @param labelKeyToDefinitionId - ルールキーから LabelDefinition の id へのマップ (`ensureLabelDefinitionsForRules` の戻り値)
 * @returns アカウントごとにシグナルを読み出せるインデックス
 */
export async function buildFollowGraphLabelIndex(
  prisma: PrismaClient,
  labelKeyToDefinitionId: Map<string, string>,
): Promise<FollowGraphLabelIndex> {
  const definitionIdToKey = new Map(
    [...labelKeyToDefinitionId.entries()].map(([key, id]) => [id, key]),
  )
  const targetDefinitionIds = [...definitionIdToKey.keys()]

  if (targetDefinitionIds.length === 0) {
    return { signalsFor: () => ({}) }
  }

  const followeeRows = await prisma.$queryRaw<AggregateRow[]>`
      SELECT
        edges."accountId",
        all_latest."labelDefinitionId",
        COUNT(*) FILTER (WHERE all_latest."value")::int AS "labeledCount",
        COUNT(*)::int AS "totalCount"
      FROM (
        SELECT "followerId" AS "accountId", "followeeId" FROM "Follow"
        UNION
        SELECT "accountId", "followeeId" FROM "LabelingFollowSample"
      ) edges
      JOIN "AccountLabelLatest" all_latest ON all_latest."accountId" = edges."followeeId"
      WHERE all_latest."labelDefinitionId" IN (${Prisma.join(targetDefinitionIds)})
      GROUP BY edges."accountId", all_latest."labelDefinitionId"
    `
  const followerRows = await prisma.$queryRaw<AggregateRow[]>`
      SELECT
        f."followeeId" AS "accountId",
        all_latest."labelDefinitionId",
        COUNT(*) FILTER (WHERE all_latest."value")::int AS "labeledCount",
        COUNT(*)::int AS "totalCount"
      FROM "Follow" f
      JOIN "AccountLabelLatest" all_latest ON all_latest."accountId" = f."followerId"
      WHERE all_latest."labelDefinitionId" IN (${Prisma.join(targetDefinitionIds)})
      GROUP BY f."followeeId", all_latest."labelDefinitionId"
    `

  const signals = new Map<string, Map<string, FollowGraphLabelSignal>>()

  function ensureEntry(accountId: string, labelDefinitionId: string): FollowGraphLabelSignal {
    const byLabel = signals.get(accountId) ?? new Map<string, FollowGraphLabelSignal>()
    signals.set(accountId, byLabel)
    const existing = byLabel.get(labelDefinitionId)
    if (existing) return existing
    const created: FollowGraphLabelSignal = {
      followeeLabeledCount: 0,
      followeeTotalCount: 0,
      followerLabeledCount: 0,
      followerTotalCount: 0,
    }
    byLabel.set(labelDefinitionId, created)
    return created
  }

  for (const row of followeeRows) {
    const entry = ensureEntry(row.accountId, row.labelDefinitionId)
    entry.followeeLabeledCount = row.labeledCount
    entry.followeeTotalCount = row.totalCount
  }
  for (const row of followerRows) {
    const entry = ensureEntry(row.accountId, row.labelDefinitionId)
    entry.followerLabeledCount = row.labeledCount
    entry.followerTotalCount = row.totalCount
  }

  return {
    signalsFor(accountId) {
      const byLabel = signals.get(accountId)
      if (!byLabel) return {}
      const result: Record<string, FollowGraphLabelSignal> = {}
      for (const [labelDefinitionId, signal] of byLabel) {
        const key = definitionIdToKey.get(labelDefinitionId)
        if (!key) continue
        result[key] = signal
      }
      return result
    },
  }
}
