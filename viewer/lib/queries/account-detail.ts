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

/**
 * ラベルの評価結果。評価されていないラベル (versions の添字が 0) は一覧に含めない。
 * 'false' と 'unevaluable' は行を持たないため、confidence・reason・method・labeledAt は null になる。
 */
export type AccountDetailLabelStatus = 'true' | 'false' | 'unevaluable'

export interface AccountDetailLabel {
  labelKey: string
  status: AccountDetailLabelStatus
  value: boolean
  confidence: number | null
  reason: string | null
  method: string | null
  /** 最後に評価したときのルールのバージョン。 */
  ruleVersion: string
  labeledAt: Date | null
  history: AccountDetailLabelHistoryEntry[]
}

export interface AccountDetailLabelHistoryEntry {
  changeType: string
  previousValue: boolean | null
  newValue: boolean | null
  previousConfidence: number | null
  newConfidence: number | null
  previousReason: string | null
  newReason: string | null
  changedAt: Date
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
// AccountLabelChange には変化があった評価のみ記録されるため、この上限は history の長さを打ち切るだけであり、
// 現在値 (labels[].value 等) は AccountLabelState と AccountActiveLabel から取得するため影響を受けない。
const ACCOUNT_LABEL_CHANGE_FETCH_LIMIT = 2000

/**
 * changedAt 降順、id 降順で取得した AccountLabelChange の一覧から、labelDefinitionId ごとの history を組み立てる。
 * @param changes - changedAt 降順、id 降順で取得した AccountLabelChange の一覧
 * @returns labelDefinitionId から history 配列へのマップ
 */
function buildLabelHistoryByDefinition(
  changes: {
    labelDefinitionId: number
    changeType: string
    previousValue: boolean | null
    newValue: boolean | null
    previousConfidence: number | null
    newConfidence: number | null
    previousReason: string | null
    newReason: string | null
    changedAt: Date
  }[],
): Map<number, AccountDetailLabelHistoryEntry[]> {
  const historyByDefinition = new Map<number, AccountDetailLabelHistoryEntry[]>()

  for (const change of changes) {
    let history = historyByDefinition.get(change.labelDefinitionId)
    if (!history) {
      history = []
      historyByDefinition.set(change.labelDefinitionId, history)
    }
    if (history.length >= LABEL_HISTORY_LIMIT) {
      continue
    }
    history.push({
      changeType: change.changeType,
      previousValue: change.previousValue,
      newValue: change.newValue,
      previousConfidence: change.previousConfidence,
      newConfidence: change.newConfidence,
      previousReason: change.previousReason,
      newReason: change.newReason,
      changedAt: change.changedAt,
    })
  }

  return historyByDefinition
}

interface LabelDefinitionWithVersions {
  id: number
  key: string
  retiredAt: Date | null
  ruleVersions: { versionNo: number; ruleVersion: string }[]
}

interface ActiveLabelRow {
  labelDefinitionId: number
  confidence: number
  reason: string
  method: string
  ruleVersionNo: number
  labeledAt: Date
}

/**
 * 評価状態と true のラベル行に、対応する history を組み合わせてラベル一覧を組み立てる。
 * 評価済みのラベルだけを返す。true の行を labeledAt 降順で先に、false と評価不能をキー順で後に並べる。
 * @param definitions - key 昇順の全 LabelDefinition (ruleVersions を含む)
 * @param versions - AccountLabelState.versions (添字は LabelDefinition.id - 1。状態行が無ければ空)
 * @param activeRows - true のラベル行
 * @param historyRows - changedAt 降順、id 降順で取得した AccountLabelChange の一覧
 * @returns ラベルごとに集約された一覧
 */
function buildLabels(
  definitions: LabelDefinitionWithVersions[],
  versions: number[],
  activeRows: ActiveLabelRow[],
  historyRows: Parameters<typeof buildLabelHistoryByDefinition>[0],
): AccountDetailLabel[] {
  const historyByDefinition = buildLabelHistoryByDefinition(historyRows)
  const activeByDefinition = new Map(activeRows.map((row) => [row.labelDefinitionId, row]))
  const trueLabels: AccountDetailLabel[] = []
  const otherLabels: AccountDetailLabel[] = []

  for (const definition of definitions) {
    const active = activeByDefinition.get(definition.id)
    const slot = versions[definition.id - 1] ?? 0
    // 廃止したラベルは、現在も true の行を持つ場合だけ表示する。
    if ((slot === 0 && !active) || (definition.retiredAt !== null && !active)) continue
    const versionNo = active?.ruleVersionNo ?? Math.abs(slot)
    const ruleVersion =
      definition.ruleVersions.find((row) => row.versionNo === versionNo)?.ruleVersion ?? ''
    const history = historyByDefinition.get(definition.id) ?? []
    if (active) {
      trueLabels.push({
        labelKey: definition.key,
        status: 'true',
        value: true,
        confidence: active.confidence,
        reason: active.reason,
        method: active.method,
        ruleVersion,
        labeledAt: active.labeledAt,
        history,
      })
    } else {
      otherLabels.push({
        labelKey: definition.key,
        status: slot < 0 ? 'unevaluable' : 'false',
        value: false,
        confidence: null,
        reason: null,
        method: null,
        ruleVersion,
        labeledAt: null,
        history,
      })
    }
  }

  trueLabels.sort(
    (left, right) => (right.labeledAt?.getTime() ?? 0) - (left.labeledAt?.getTime() ?? 0),
  )
  return [...trueLabels, ...otherLabels]
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
    labelState,
    activeLabels,
    labelDefinitions,
    labelHistoryRows,
    tweets,
    followingEdges,
    followingCount,
    followerEdges,
    followerCount,
    blockedEdges,
    blockedCount,
  ] = await Promise.all([
    prisma.accountLabelState.findUnique({ where: { accountId }, select: { versions: true } }),
    prisma.accountActiveLabel.findMany({ where: { accountId } }),
    prisma.labelDefinition.findMany({
      orderBy: { key: 'asc' },
      include: { ruleVersions: { select: { versionNo: true, ruleVersion: true } } },
    }),
    prisma.accountLabelChange.findMany({
      where: { accountId },
      // 再ラベリングが短時間に連続すると changedAt が同一になりうるため、id をタイブレークにして順序を固定する。
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: ACCOUNT_LABEL_CHANGE_FETCH_LIMIT,
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
    labels: buildLabels(
      labelDefinitions,
      labelState?.versions ?? [],
      activeLabels,
      labelHistoryRows,
    ),
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
