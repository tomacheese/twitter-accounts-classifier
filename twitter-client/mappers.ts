export interface RawUserResult {
  restId: string
  legacy: {
    screenName: string
    name: string
    description: string | null
    followersCount: number
    friendsCount: number
    statusesCount: number
    createdAt: string
    profileImageUrlHttps: string | null
    location: string | null
    url: string | null
  }
  isBlueVerified: boolean
  verifiedType: string | null
  professionalType: string | null
  parodyCommentaryFanLabel: string | null
}

export interface RawTweetResult {
  restId: string
  legacy: {
    fullText: string
    createdAt: string
    retweetCount: number
    favoriteCount: number
    replyCount: number
    quoteCount: number
    inReplyToStatusIdStr: string | null
    retweetedStatusIdStr: string | null
    isPromoted?: boolean
    isPaidPromotion?: boolean
    hasAiGeneratedMedia?: boolean | null
    aiGeneratedDetectionSource?: string | null
    entities?: {
      urls?: { url: string; expandedUrl?: string }[]
    }
    extendedEntities?: {
      media?: { type: string; sourceUserIdStr?: string | null }[]
    }
    quotedStatusResult?: {
      result: {
        restId: string
        // 引用元ツイートが tombstone・非表示の場合に欠落するため optional にしている。
        legacy?: {
          extendedEntities?: {
            media?: { type: string }[]
          }
        }
        user?: {
          restId: string
        }
      }
    } | null
  }
  user: RawUserResult
}

export interface NormalizedAccountProfile {
  id: string
  screenName: string
  displayName: string
  bio: string | null
  profileImageUrl: string | null
  followersCount: number
  followingCount: number
  tweetCount: number
  accountCreatedAt: Date
  location: string | null
  url: string | null
  isBlueVerified: boolean
  verifiedType: string | null
  professionalType: string | null
  parodyCommentaryFanLabel: string | null
}

export type NormalizedTweetSource = 'recommended' | 'following' | 'trending' | 'profile' | 'manual'

export interface NormalizedTweet {
  id: string
  accountId: string
  fullText: string
  createdAt: Date
  retweetCount: number
  likeCount: number
  replyCount: number
  quoteCount: number
  isReply: boolean
  inReplyToTweetId: string | null
  isAuthorReply: boolean
  isRetweet: boolean
  retweetedTweetId: string | null
  isPromoted: boolean
  isPaidPromotion: boolean
  expandedUrls?: string[]
  hasAiGeneratedMedia: boolean | null
  aiGeneratedDetectionSource: string | null
  foreignVideoSourceCount?: number | null
  quotedTweetId: string | null
  quotedTweetAuthorId: string | null
  quotedTweetHasVideo: boolean | null
  source: NormalizedTweetSource
}

export function toAccountProfileInput(raw: RawUserResult): NormalizedAccountProfile {
  return {
    id: raw.restId,
    screenName: raw.legacy.screenName,
    displayName: raw.legacy.name,
    bio: raw.legacy.description,
    profileImageUrl: raw.legacy.profileImageUrlHttps,
    followersCount: raw.legacy.followersCount,
    followingCount: raw.legacy.friendsCount,
    tweetCount: raw.legacy.statusesCount,
    accountCreatedAt: new Date(raw.legacy.createdAt),
    location: raw.legacy.location,
    url: raw.legacy.url,
    isBlueVerified: raw.isBlueVerified,
    verifiedType: raw.verifiedType,
    professionalType: raw.professionalType,
    parodyCommentaryFanLabel: raw.parodyCommentaryFanLabel,
  }
}

export interface ToTweetInputContext {
  source: NormalizedTweetSource
  viewerAccountId: string
}

function mergeUniqueStrings(
  current: string[] | undefined,
  previous: string[] | undefined,
): string[] {
  return [...new Set([...(current ?? []), ...(previous ?? [])])]
}

function mergeForeignVideoSourceCount(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (current == null) return previous ?? null
  if (previous == null) return current
  return Math.max(current, previous)
}

/**
 * 同一ツイートが複数の取得経路で観測された際、
 * 広告開示メタデータや引用先の `legacy` を保持しているのは一部の経路だけということがあり得るため、
 * id ごとに単純に上書きするのではなく OR 結合・coalesce によってフィールドを統合している。
 * @param tweets - 重複する id を含み得るツイート
 * @returns id ごとに 1 件へ統合したツイート。他のフィールドは最後に観測したコピーの値を保持しつつ、
 *   `isPromoted`・`isPaidPromotion` は OR 結合し、引用ツイート関連のフィールドは coalesce する。
 *   coalesce では同一 id の全コピー中で非 null 値を優先し、なければ統合値にフォールバックする。
 */
export function mergeTweetAdFlags(tweets: NormalizedTweet[]): NormalizedTweet[] {
  const byId = new Map<string, NormalizedTweet>()
  for (const tweet of tweets) {
    const existing = byId.get(tweet.id)
    byId.set(tweet.id, {
      ...tweet,
      isPromoted: tweet.isPromoted || (existing?.isPromoted ?? false),
      isPaidPromotion: tweet.isPaidPromotion || (existing?.isPaidPromotion ?? false),
      expandedUrls: mergeUniqueStrings(tweet.expandedUrls, existing?.expandedUrls),
      foreignVideoSourceCount: mergeForeignVideoSourceCount(
        tweet.foreignVideoSourceCount,
        existing?.foreignVideoSourceCount,
      ),
      quotedTweetId: tweet.quotedTweetId ?? existing?.quotedTweetId ?? null,
      quotedTweetAuthorId: tweet.quotedTweetAuthorId ?? existing?.quotedTweetAuthorId ?? null,
      quotedTweetHasVideo: tweet.quotedTweetHasVideo ?? existing?.quotedTweetHasVideo ?? null,
    })
  }
  return [...byId.values()]
}

export function toTweetInput(raw: RawTweetResult, context: ToTweetInputContext): NormalizedTweet {
  const isReply = raw.legacy.inReplyToStatusIdStr !== null
  const isRetweet = raw.legacy.retweetedStatusIdStr !== null

  const quotedResult = raw.legacy.quotedStatusResult?.result ?? null
  // 引用先が tombstone・非表示で判定不能な場合と、
  // 判定した結果として動画がない場合を区別できるよう、
  // 単純な boolean ではなく null を未評価として使い分ける。
  const quotedTweetHasVideo = quotedResult?.legacy
    ? (quotedResult.legacy.extendedEntities?.media ?? []).some(
        (media) => media.type === 'video' || media.type === 'animated_gif',
      )
    : null
  const expandedUrls = [
    ...new Set(
      (raw.legacy.entities?.urls ?? [])
        .map((entry) => entry.expandedUrl?.trim() ?? entry.url.trim())
        .filter((url) => url.length > 0),
    ),
  ]
  const foreignVideoSourceCount = raw.legacy.extendedEntities
    ? (raw.legacy.extendedEntities.media?.filter(
        (media) =>
          (media.type === 'video' || media.type === 'animated_gif') &&
          media.sourceUserIdStr != null &&
          media.sourceUserIdStr !== raw.user.restId,
      ).length ?? 0)
    : null

  return {
    id: raw.restId,
    accountId: raw.user.restId,
    fullText: raw.legacy.fullText,
    createdAt: new Date(raw.legacy.createdAt),
    retweetCount: raw.legacy.retweetCount,
    likeCount: raw.legacy.favoriteCount,
    replyCount: raw.legacy.replyCount,
    quoteCount: raw.legacy.quoteCount,
    isReply,
    inReplyToTweetId: raw.legacy.inReplyToStatusIdStr,
    isAuthorReply: isReply && raw.user.restId === context.viewerAccountId,
    isRetweet,
    retweetedTweetId: raw.legacy.retweetedStatusIdStr,
    isPromoted: raw.legacy.isPromoted ?? false,
    isPaidPromotion: raw.legacy.isPaidPromotion ?? false,
    expandedUrls,
    hasAiGeneratedMedia: raw.legacy.hasAiGeneratedMedia ?? null,
    aiGeneratedDetectionSource: raw.legacy.aiGeneratedDetectionSource ?? null,
    foreignVideoSourceCount,
    quotedTweetId: quotedResult?.restId ?? null,
    quotedTweetAuthorId: quotedResult?.user?.restId ?? null,
    quotedTweetHasVideo,
    source: context.source,
  }
}
