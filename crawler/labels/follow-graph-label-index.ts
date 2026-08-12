import { Prisma, type PrismaClient } from '../generated/prisma'
import { getRelabelerWorkerChunkSize } from '../config/env'

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

export interface BuildFollowGraphLabelIndexOptions {
  /** 指定時、シグナルを構築する対象 (集計クエリの WHERE 対象) をこの account 群に限定する。省略時は全 account が対象。 */
  accountIds?: string[]
}

/**
 * フォロー先方向は `Follow` と `LabelingFollowSample` の両方を、
 * フォロワー方向は `Follow` を、それぞれ `AccountLabelLatest` と突き合わせる集約クエリで、
 * アカウント単位のグラフ探索を行わずにラベルごとの既存付与状況を組み立てる。
 * 参照するのは呼び出し時点までに永続化済みの `AccountLabelLatest` の値であり、
 * 同一実行中に先行して確定したラベルも含まれうる。
 * @param prisma - 問い合わせに使う Prisma クライアント
 * @param labelKeyToDefinitionId - ルールキーから LabelDefinition の id へのマップ (`ensureLabelDefinitionsForRules` の戻り値)
 * @param options - 集計対象を絞り込むオプション
 * @returns アカウントごとにシグナルを読み出せるインデックス
 */
export async function buildFollowGraphLabelIndex(
  prisma: PrismaClient,
  labelKeyToDefinitionId: Map<string, string>,
  options?: BuildFollowGraphLabelIndexOptions,
): Promise<FollowGraphLabelIndex> {
  const definitionIdToKey = new Map(
    [...labelKeyToDefinitionId.entries()].map(([key, id]) => [id, key]),
  )
  const targetDefinitionIds = [...definitionIdToKey.keys()]

  if (targetDefinitionIds.length === 0) {
    return { signalsFor: () => ({}) }
  }

  const accountIds = options?.accountIds

  // Prisma.sql/Prisma.empty による条件付き SQL 合成は $queryRaw モックの呼び出し引数に断片が反映されず、
  // テストで WHERE 句の有無を検証できない。そのため ids の有無で完全に別クエリに分岐させている。
  async function fetchFolloweeRows(ids?: string[]): Promise<AggregateRow[]> {
    return ids
      ? prisma.$queryRaw<AggregateRow[]>`
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
          AND edges."accountId" = ANY(${ids})
        GROUP BY edges."accountId", all_latest."labelDefinitionId"
      `
      : prisma.$queryRaw<AggregateRow[]>`
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
  }

  async function fetchFollowerRows(ids?: string[]): Promise<AggregateRow[]> {
    return ids
      ? prisma.$queryRaw<AggregateRow[]>`
        SELECT
          f."followeeId" AS "accountId",
          all_latest."labelDefinitionId",
          COUNT(*) FILTER (WHERE all_latest."value")::int AS "labeledCount",
          COUNT(*)::int AS "totalCount"
        FROM "Follow" f
        JOIN "AccountLabelLatest" all_latest ON all_latest."accountId" = f."followerId"
        WHERE all_latest."labelDefinitionId" IN (${Prisma.join(targetDefinitionIds)})
          AND f."followeeId" = ANY(${ids})
        GROUP BY f."followeeId", all_latest."labelDefinitionId"
      `
      : prisma.$queryRaw<AggregateRow[]>`
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
  }

  const followeeRows: AggregateRow[] = []
  const followerRows: AggregateRow[] = []

  if (accountIds) {
    // クエリ latency を chunk size で頭打ちにするため、accountIds を分割して直列実行する。
    // 並列化すると同時に DB へ投げるクエリ本数が増え、DB 負荷低減という目的に反するため採用しない。
    const chunkSize = getRelabelerWorkerChunkSize()
    for (let i = 0; i < accountIds.length; i += chunkSize) {
      const chunk = accountIds.slice(i, i + chunkSize)
      followeeRows.push(...(await fetchFolloweeRows(chunk)))
      followerRows.push(...(await fetchFollowerRows(chunk)))
    }
  } else {
    followeeRows.push(...(await fetchFolloweeRows()))
    followerRows.push(...(await fetchFollowerRows()))
  }

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
