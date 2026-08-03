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
// AccountLabel には変化があった評価のみ記録されるため、この上限は history の長さを打ち切るだけであり、
// 現在値 (labels[].value 等) は AccountLabelLatest から取得するため影響を受けない。
const ACCOUNT_LABEL_FETCH_LIMIT = 2000

/**
 * labeledAt 降順、id 降順で取得した AccountLabel の一覧から、labelDefinitionId ごとの history を組み立てる。
 * 各ラベルの最新行 (AccountLabelLatest の現在値と重複する) は除外し、それより前の変化のみを保持する。
 * @param labels - labeledAt 降順、id 降順で取得した AccountLabel の一覧
 * @returns labelDefinitionId から history 配列へのマップ
 */
function buildLabelHistoryByDefinition(
  labels: {
    labelDefinitionId: string
    value: boolean
    confidence: number
    reason: string
    method: string
    ruleVersion: string
    labeledAt: Date
  }[],
): Map<string, AccountDetailLabelHistoryEntry[]> {
  const historyByDefinition = new Map<string, AccountDetailLabelHistoryEntry[]>()
  const seenMostRecent = new Set<string>()

  for (const label of labels) {
    if (!seenMostRecent.has(label.labelDefinitionId)) {
      seenMostRecent.add(label.labelDefinitionId)
      continue
    }
    let history = historyByDefinition.get(label.labelDefinitionId)
    if (!history) {
      history = []
      historyByDefinition.set(label.labelDefinitionId, history)
    }
    if (history.length >= LABEL_HISTORY_LIMIT) {
      continue
    }
    history.push({
      value: label.value,
      confidence: label.confidence,
      reason: label.reason,
      method: label.method,
      ruleVersion: label.ruleVersion,
      labeledAt: label.labeledAt,
    })
  }

  return historyByDefinition
}

/**
 * AccountLabelLatest の現在値一覧に、対応する history を組み合わせてラベル一覧を組み立てる。
 * @param latestLabels - labeledAt 降順で取得した AccountLabelLatest の一覧 (labelDefinition を含む)
 * @param historyRows - labeledAt 降順、id 降順で取得した AccountLabel の一覧
 * @returns ラベルごとに集約された一覧。並び順は AccountLabelLatest の並び順を保つ。
 */
function groupLabelsByDefinition(
  latestLabels: {
    labelDefinitionId: string
    labelDefinition: { key: string }
    value: boolean
    confidence: number
    reason: string
    method: string
    ruleVersion: string
    labeledAt: Date
  }[],
  historyRows: {
    labelDefinitionId: string
    value: boolean
    confidence: number
    reason: string
    method: string
    ruleVersion: string
    labeledAt: Date
  }[],
): AccountDetailLabel[] {
  const historyByDefinition = buildLabelHistoryByDefinition(historyRows)

  return latestLabels.map((label) => ({
    labelKey: label.labelDefinition.key,
    value: label.value,
    confidence: label.confidence,
    reason: label.reason,
    method: label.method,
    ruleVersion: label.ruleVersion,
    labeledAt: label.labeledAt,
    history: historyByDefinition.get(label.labelDefinitionId) ?? [],
  }))
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
    latestLabels,
    labelHistoryRows,
    tweets,
    followingEdges,
    followingCount,
    followerEdges,
    followerCount,
    blockedEdges,
    blockedCount,
  ] = await Promise.all([
    prisma.accountLabelLatest.findMany({
      where: { accountId },
      orderBy: { labeledAt: 'desc' },
      include: { labelDefinition: true },
    }),
    prisma.accountLabel.findMany({
      where: { accountId },
      // 再ラベリングが短時間に連続すると labeledAt が同一になりうるため、id をタイブレークにして順序を固定する。
      orderBy: [{ labeledAt: 'desc' }, { id: 'desc' }],
      take: ACCOUNT_LABEL_FETCH_LIMIT,
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
    labels: groupLabelsByDefinition(latestLabels, labelHistoryRows),
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
