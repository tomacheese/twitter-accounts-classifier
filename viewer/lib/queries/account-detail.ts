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
  history: AccountDetailLabelHistoryEntry[]
}

export interface AccountDetailLabelHistoryEntry {
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
  blocked: AccountDetailFollowList
}

const FOLLOW_LIST_LIMIT = 100
// history の件数を無制限に返すと再ラベリングを繰り返したアカウントほどページの転送量が増え続けるため、上限を設けて打ち切る。
const LABEL_HISTORY_LIMIT = 20
// ラベルルールが true/false を繰り返した場合でも 1 アカウントのページ読み込みが際限なく重くならないための防御的な上限。
const ACCOUNT_LABEL_FETCH_LIMIT = 2000

/**
 * labeledAt 降順、id 降順で取得した AccountLabel の一覧を labelDefinitionId ごとに集約する。
 * @param labels - labeledAt 降順、id 降順で取得した AccountLabel の一覧 (labelDefinition を含む)
 * @returns ラベルごとに集約された一覧。並び順は各ラベルの最新評価が現れた順を保つ。
 */
function groupLabelsByDefinition(
  labels: {
    labelDefinitionId: string
    labelDefinition: { key: string }
    value: boolean
    confidence: number
    reason: string
    method: string
    ruleVersion: string
    labeledAt: Date
  }[],
): AccountDetailLabel[] {
  const grouped = new Map<string, AccountDetailLabel>()

  for (const label of labels) {
    const existing = grouped.get(label.labelDefinitionId)
    if (!existing) {
      grouped.set(label.labelDefinitionId, {
        labelKey: label.labelDefinition.key,
        value: label.value,
        confidence: label.confidence,
        reason: label.reason,
        method: label.method,
        ruleVersion: label.ruleVersion,
        labeledAt: label.labeledAt,
        history: [],
      })
      continue
    }
    if (existing.history.length >= LABEL_HISTORY_LIMIT) {
      continue
    }
    existing.history.push({
      value: label.value,
      confidence: label.confidence,
      reason: label.reason,
      method: label.method,
      ruleVersion: label.ruleVersion,
      labeledAt: label.labeledAt,
    })
  }

  return [...grouped.values()]
}

/**
 * アカウントの詳細情報を取得する。
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

  const [
    labels,
    tweets,
    followingEdges,
    followingCount,
    followerEdges,
    followerCount,
    blockedEdges,
    blockedCount,
  ] = await Promise.all([
    prisma.accountLabel.findMany({
      where: { accountId },
      // 再ラベリングが短時間に連続すると labeledAt が同一になりうるため、id をタイブレークにして順序を固定する。
      orderBy: [{ labeledAt: 'desc' }, { id: 'desc' }],
      take: ACCOUNT_LABEL_FETCH_LIMIT,
      include: { labelDefinition: true },
    }),
    prisma.tweet.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: tweetLimit,
    }),
    prisma.follow.findMany({
      where: { followerId: accountId },
      // 1回のクロールで同じ方向の全エッジに同一の lastSeenAt が付くため、タイブレークを固定しないとページ読み込みごとに一覧の中身が変動しうる。
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
    prisma.block.findMany({
      where: { blockerId: accountId },
      orderBy: [{ lastSeenAt: 'desc' }, { blockedId: 'asc' }],
      take: FOLLOW_LIST_LIMIT,
      include: { blocked: true },
    }),
    prisma.block.count({ where: { blockerId: accountId } }),
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
    labels: groupLabelsByDefinition(labels),
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
    blocked: {
      entries: blockedEdges.map((edge) => ({
        id: edge.blocked.id,
        screenName: edge.blocked.screenName,
        displayName: edge.blocked.displayName,
        profileImageUrl: edge.blocked.profileImageUrl,
      })),
      totalCount: blockedCount,
    },
  }
}
