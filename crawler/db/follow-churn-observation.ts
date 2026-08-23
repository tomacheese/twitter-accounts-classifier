import type { PrismaClient } from '../generated/prisma'

/** Follow 状態変化の集計結果。 */
export interface FollowChurnObservation {
  followed: number
  unfollowed: number
  completedCycles: number
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
