import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { upsertAccount } from './account-repository'
import type { FollowListResult } from '../twitter/follows'

const logger = Logger.configure('follow-repository')

// Each account is upserted independently, mirroring `upsertTweets`' per-item error
// handling in `./tweet-repository` - a single bad profile (e.g. a suspended account
// appearing in a follow list) must not stop the rest of the batch, nor the edge sync
// that follows it, from being persisted.
async function upsertFollowAuthors(prisma: PrismaClient, result: FollowListResult): Promise<void> {
  for (const author of result.authors) {
    try {
      await upsertAccount(prisma, author)
    } catch (error) {
      logger.error(
        `Failed to upsert account ${author.id} while syncing follow edges`,
        error as Error,
      )
    }
  }
}

/**
 * Syncs the `Follow` edges for the accounts a given account follows: upserts an `Account`
 * row for each discovered account, then upserts a `Follow` edge per id. When `result.reachedEnd`
 * is true (the full following list was enumerated), also deletes edges for accounts no
 * longer present, detecting unfollows. The edge upserts and the prune run in a single
 * transaction so a mid-sync failure never leaves stale and fresh edges inconsistently mixed.
 * @param prisma - the Prisma client
 * @param followerId - the account whose following list this is
 * @param result - the fetched following list
 */
export async function syncFollowing(
  prisma: PrismaClient,
  followerId: string,
  result: FollowListResult,
): Promise<void> {
  await upsertFollowAuthors(prisma, result)
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    if (result.ids.length > 0) {
      await tx.follow.createMany({
        data: result.ids.map((followeeId) => ({
          followerId,
          followeeId,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
        skipDuplicates: true,
      })
      await tx.follow.updateMany({
        where: { followerId, followeeId: { in: result.ids } },
        data: { lastSeenAt: now },
      })
    }

    // `reachedEnd` alone isn't enough to gate pruning: an empty `result.ids` compiles
    // `notIn: []` to a match-everything predicate, so a single transient empty-page
    // response (rate limiting, an auth hiccup) would wipe every recorded edge instead of
    // just the ones actually gone. Requiring at least one confirmed-current id anchors
    // the comparison; an account that genuinely unfollows everyone keeps its last stale
    // edge until a future cycle observes at least one live id again.
    if (result.reachedEnd && result.ids.length > 0) {
      await tx.follow.deleteMany({
        where: { followerId, followeeId: { notIn: result.ids } },
      })
    }
  })
}

/**
 * Syncs the `Follow` edges for the accounts that follow a given account - the symmetric
 * counterpart of {@link syncFollowing}, fixing `followeeId` instead of `followerId`.
 * @param prisma - the Prisma client
 * @param followeeId - the account whose follower list this is
 * @param result - the fetched follower list
 */
export async function syncFollowers(
  prisma: PrismaClient,
  followeeId: string,
  result: FollowListResult,
): Promise<void> {
  await upsertFollowAuthors(prisma, result)
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    if (result.ids.length > 0) {
      await tx.follow.createMany({
        data: result.ids.map((followerId) => ({
          followerId,
          followeeId,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
        skipDuplicates: true,
      })
      await tx.follow.updateMany({
        where: { followeeId, followerId: { in: result.ids } },
        data: { lastSeenAt: now },
      })
    }

    // See the matching comment in `syncFollowing` above.
    if (result.reachedEnd && result.ids.length > 0) {
      await tx.follow.deleteMany({
        where: { followeeId, followerId: { notIn: result.ids } },
      })
    }
  })
}
