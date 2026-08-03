import type { PrismaClient } from '../../generated/prisma'

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

export interface AccountDetailLabel {
  labelKey: string
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  labeledAt: Date
}

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

export interface AccountDetailFollowEntry {
  id: string
  screenName: string
  displayName: string
  profileImageUrl: string | null
}

export interface AccountDetailFollowList {
  entries: AccountDetailFollowEntry[]
  totalCount: number
}

export interface AccountDetail {
  account: AccountDetailProfile
  labels: AccountDetailLabel[]
  recentTweets: AccountDetailTweet[]
  following: AccountDetailFollowList
  followers: AccountDetailFollowList
}

const FOLLOW_LIST_LIMIT = 100

/**
 * 各ラベルの最新評価のみではなく、AccountLabel の履歴全体を返す。
 * @param prisma - クエリを実行する Prisma クライアント
 * @param accountId - アカウントの ID
 * @param tweetLimit - 含める直近ツイートの最大件数
 * @returns アカウント詳細、該当する ID のアカウントが存在しない場合は `null`
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
        // 1回のクロールで同じ方向の全エッジに同一の lastSeenAt が付くため、
        // タイブレークを固定しないとページ読み込みごとに一覧の中身が変動しうる。
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
