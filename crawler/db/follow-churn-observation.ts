import type { PrismaClient } from '../generated/prisma'

/** Follow 状態変化の集計結果。 */
export interface FollowChurnObservation {
  followed: number
  unfollowed: number
  completedCycles: number
}

/**
 * bulk follow/unfollow 検出ルールが観測対象とする、現在時刻からの遡及日数。
 */
export const FOLLOW_CHURN_OBSERVATION_WINDOW_DAYS = 14

/** `aggregateFollowChurn` の集計に必要な列のみを持つ、`FollowStateChange` の部分形。 */
interface FollowStateChangeRecord {
  followeeId: string
  changeType: string
}

/**
 * followee 単位で `followed`→`unfollowed` の完了サイクルを数える、集計の中核ロジック。
 * `changes` は followeeId 昇順・observedAt 昇順 (同時刻は id 昇順) にソート済みであることを前提とする。
 */
function aggregateFollowChurn(changes: FollowStateChangeRecord[]): FollowChurnObservation {
  let followed = 0
  let unfollowed = 0
  let completedCycles = 0
  const followingFollowees = new Set<string>()

  for (const change of changes) {
    if (change.changeType === 'followed') {
      followed += 1
      followingFollowees.add(change.followeeId)
      continue
    }

    if (change.changeType === 'unfollowed') {
      unfollowed += 1
      if (followingFollowees.delete(change.followeeId)) completedCycles += 1
    }
  }

  return { followed, unfollowed, completedCycles }
}

/**
 * 指定時点以降の Follow 状態変化を、アカウントがフォローした相手ごとに集計する。
 */
export async function loadFollowChurnObservation(
  prisma: PrismaClient,
  accountId: string,
  since: Date,
): Promise<FollowChurnObservation> {
  const changes = await prisma.followStateChange.findMany({
    where: { followerId: accountId, observedAt: { gte: since } },
    select: { id: true, followeeId: true, changeType: true, observedAt: true },
    orderBy: [{ followeeId: 'asc' }, { observedAt: 'asc' }, { id: 'asc' }],
  })

  return aggregateFollowChurn(changes)
}

/**
 * 複数アカウント分の Follow 状態変化を、group 単位で1回の DB ラウンドトリップにまとめて集計する。
 * 対象期間内に `FollowStateChange` を持たないアカウントは戻り値の Map にキーごと含まない。
 * @param prisma - Prisma クライアント
 * @param accountIds - 集計対象のアカウント (follower) id 一覧
 * @param since - この時刻以降の状態変化のみを対象にする
 * @returns accountId ごとの集計結果を持つ Map
 */
export async function loadFollowChurnObservationsForAccounts(
  prisma: PrismaClient,
  accountIds: string[],
  since: Date,
): Promise<Map<string, FollowChurnObservation>> {
  if (accountIds.length === 0) return new Map()

  const changes = await prisma.followStateChange.findMany({
    where: { followerId: { in: accountIds }, observedAt: { gte: since } },
    select: { id: true, followerId: true, followeeId: true, changeType: true, observedAt: true },
    orderBy: [{ followerId: 'asc' }, { followeeId: 'asc' }, { observedAt: 'asc' }, { id: 'asc' }],
  })

  const changesByFollowerId = new Map<string, FollowStateChangeRecord[]>()
  for (const change of changes) {
    const list = changesByFollowerId.get(change.followerId) ?? []
    list.push(change)
    changesByFollowerId.set(change.followerId, list)
  }

  const result = new Map<string, FollowChurnObservation>()
  for (const [followerId, followerChanges] of changesByFollowerId) {
    result.set(followerId, aggregateFollowChurn(followerChanges))
  }
  return result
}
