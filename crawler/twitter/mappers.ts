import type { AccountProfileInput } from '../db/account-repository'
import type { TweetInput, TweetSource } from '../db/tweet-repository'

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

export function toAccountProfileInput(raw: RawUserResult): AccountProfileInput {
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
  source: TweetSource
  viewerAccountId: string
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
 * 同一ツイートが複数の取得経路で観測された際、広告開示メタデータや引用先の
 * `legacy` を保持しているのは一部の経路だけということがあり得るため、id ごとに
 * 単純に上書きするのではなく OR 結合・coalesce によってフィールドを統合している。
 * @param tweets - tweets that may contain duplicate ids
 * @returns one tweet per id, keeping the last-seen copy's other fields but with
 * `isPromoted`/`isPaidPromotion` OR'd, and the quoted-tweet fields coalesced (prefer the
 * current copy's non-null value, falling back to the previously merged copy's), across
 * all copies of that id
 */
export function mergeTweetAdFlags(tweets: TweetInput[]): TweetInput[] {
  const byId = new Map<string, TweetInput>()
  for (const tweet of tweets) {
    const existing = byId.get(tweet.id)
    byId.set(tweet.id, {
      ...tweet,
      isPromoted: tweet.isPromoted || (existing?.isPromoted ?? false),
      isPaidPromotion: tweet.isPaidPromotion || (existing?.isPaidPromotion ?? false),
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

export function toTweetInput(raw: RawTweetResult, context: ToTweetInputContext): TweetInput {
  const isReply = raw.legacy.inReplyToStatusIdStr !== null
  const isRetweet = raw.legacy.retweetedStatusIdStr !== null

  const quotedResult = raw.legacy.quotedStatusResult?.result ?? null
  // 引用先が tombstone・非表示で判定不能な場合と、判定した結果として動画がない
  // 場合を区別できるよう、単純な boolean ではなく null を未評価として使い分ける。
  const quotedTweetHasVideo = quotedResult?.legacy
    ? (quotedResult.legacy.extendedEntities?.media ?? []).some(
        (media) => media.type === 'video' || media.type === 'animated_gif',
      )
    : null
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
    hasAiGeneratedMedia: raw.legacy.hasAiGeneratedMedia ?? null,
    aiGeneratedDetectionSource: raw.legacy.aiGeneratedDetectionSource ?? null,
    foreignVideoSourceCount,
    quotedTweetId: quotedResult?.restId ?? null,
    quotedTweetAuthorId: quotedResult?.user?.restId ?? null,
    quotedTweetHasVideo,
    source: context.source,
  }
}
