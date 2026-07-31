import type { PrismaClient } from '../../generated/prisma'

/**
 * The account profile fields shown at the top of the account detail page.
 */
export interface AccountDetailProfile {
  id: string
  screenName: string
  displayName: string
  bio: string | null
  profileImageUrl: string | null
  followersCount: number
  followingCount: number
  tweetCount: number
  accountCreatedAt: Date
  isBlueVerified: boolean
  verifiedType: string | null
}

/**
 * A single `AccountLabel` history row for an account, shown on the detail page.
 */
export interface AccountDetailLabel {
  labelKey: string
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  labeledAt: Date
}

/**
 * A single recent tweet shown on the account detail page.
 */
export interface AccountDetailTweet {
  id: string
  fullText: string
  createdAt: Date
  retweetCount: number
  likeCount: number
  isReply: boolean
  isRetweet: boolean
  isPromoted: boolean
  isPaidPromotion: boolean
}

/**
 * One account shown in an account's following/followers list.
 */
export interface AccountDetailFollowEntry {
  id: string
  screenName: string
  displayName: string
  profileImageUrl: string | null
}

/**
 * A capped list of following/follower entries, plus the true total count.
 */
export interface AccountDetailFollowList {
  entries: AccountDetailFollowEntry[]
  totalCount: number
}

/**
 * The full account detail view: profile, complete label history, and recent tweets.
 */
export interface AccountDetail {
  account: AccountDetailProfile
  labels: AccountDetailLabel[]
  recentTweets: AccountDetailTweet[]
  following: AccountDetailFollowList
  followers: AccountDetailFollowList
}

/** The maximum number of following/follower rows returned per direction. */
const FOLLOW_LIST_LIMIT = 100

/**
 * Loads the full detail view for a single account: its profile, its
 * complete `AccountLabel` history (not just the latest evaluation per
 * label), and its most recent tweets.
 * @param prisma - the Prisma client to query
 * @param accountId - the account's ID
 * @param tweetLimit - the maximum number of recent tweets to include
 * @returns the account detail, or `null` if no account with that ID exists
 */
export async function getAccountDetail(
  prisma: PrismaClient,
  accountId: string,
  tweetLimit: number,
): Promise<AccountDetail | null> {
  const account = await prisma.account.findUnique({ where: { id: accountId } })
  if (!account) {
    return null
  }

  const [labels, tweets, followingEdges, followingCount, followerEdges, followerCount] =
    await Promise.all([
      prisma.accountLabel.findMany({
        where: { accountId },
        orderBy: { labeledAt: 'desc' },
        include: { labelDefinition: true },
      }),
      prisma.tweet.findMany({
        where: { accountId },
        orderBy: { createdAt: 'desc' },
        take: tweetLimit,
      }),
      prisma.follow.findMany({
        where: { followerId: accountId },
        // A crawl cycle stamps every edge in a direction with the same `lastSeenAt`, so
        // ties need a stable tiebreaker or the capped list's contents could vary between
        // page loads with no underlying data change.
        orderBy: [{ lastSeenAt: 'desc' }, { followeeId: 'asc' }],
        take: FOLLOW_LIST_LIMIT,
        include: { followee: true },
      }),
      prisma.follow.count({ where: { followerId: accountId } }),
      prisma.follow.findMany({
        where: { followeeId: accountId },
        orderBy: [{ lastSeenAt: 'desc' }, { followerId: 'asc' }],
        take: FOLLOW_LIST_LIMIT,
        include: { follower: true },
      }),
      prisma.follow.count({ where: { followeeId: accountId } }),
    ])

  return {
    account: {
      id: account.id,
      screenName: account.screenName,
      displayName: account.displayName,
      bio: account.bio,
      profileImageUrl: account.profileImageUrl,
      followersCount: account.followersCount,
      followingCount: account.followingCount,
      tweetCount: account.tweetCount,
      accountCreatedAt: account.accountCreatedAt,
      isBlueVerified: account.isBlueVerified,
      verifiedType: account.verifiedType,
    },
    labels: labels.map((label) => ({
      labelKey: label.labelDefinition.key,
      value: label.value,
      confidence: label.confidence,
      reason: label.reason,
      method: label.method,
      ruleVersion: label.ruleVersion,
      labeledAt: label.labeledAt,
    })),
    recentTweets: tweets.map((tweet) => ({
      id: tweet.id,
      fullText: tweet.fullText,
      createdAt: tweet.createdAt,
      retweetCount: tweet.retweetCount,
      likeCount: tweet.likeCount,
      isReply: tweet.isReply,
      isRetweet: tweet.isRetweet,
      isPromoted: tweet.isPromoted,
      isPaidPromotion: tweet.isPaidPromotion,
    })),
    following: {
      entries: followingEdges.map((edge) => ({
        id: edge.followee.id,
        screenName: edge.followee.screenName,
        displayName: edge.followee.displayName,
        profileImageUrl: edge.followee.profileImageUrl,
      })),
      totalCount: followingCount,
    },
    followers: {
      entries: followerEdges.map((edge) => ({
        id: edge.follower.id,
        screenName: edge.follower.screenName,
        displayName: edge.follower.displayName,
        profileImageUrl: edge.follower.profileImageUrl,
      })),
      totalCount: followerCount,
    },
  }
}
