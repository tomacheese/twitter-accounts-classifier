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
    quotedStatusResult?: {
      result: {
        restId: string
        legacy: {
          extendedEntities?: {
            media?: { type: string }[]
          }
        }
        user: {
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

/**
 * Deduplicates tweets by id, OR-ing `isPromoted`/`isPaidPromotion` across duplicate
 * copies of the same tweet id. The same tweet can be observed multiple times through
 * different fetch paths (e.g. a timeline injection and the author's own profile-fetched
 * tweet list), and only one of those paths may carry the ad-disclosure metadata (e.g.
 * `promotedMetadata`) needed to detect it - a plain overwrite would let whichever copy
 * is merged/persisted last silently discard a `true` flag observed via another path.
 * @param tweets - tweets that may contain duplicate ids
 * @returns one tweet per id, keeping the last-seen copy's other fields but with
 * `isPromoted`/`isPaidPromotion` OR'd across all copies of that id
 */
export function mergeTweetAdFlags(tweets: TweetInput[]): TweetInput[] {
  const byId = new Map<string, TweetInput>()
  for (const tweet of tweets) {
    const existing = byId.get(tweet.id)
    byId.set(tweet.id, {
      ...tweet,
      isPromoted: tweet.isPromoted || (existing?.isPromoted ?? false),
      isPaidPromotion: tweet.isPaidPromotion || (existing?.isPaidPromotion ?? false),
    })
  }
  return [...byId.values()]
}

export function toTweetInput(raw: RawTweetResult, context: ToTweetInputContext): TweetInput {
  const isReply = raw.legacy.inReplyToStatusIdStr !== null
  const isRetweet = raw.legacy.retweetedStatusIdStr !== null

  const quotedResult = raw.legacy.quotedStatusResult?.result ?? null
  const quotedMedia = quotedResult?.legacy.extendedEntities?.media ?? []
  const quotedTweetHasVideo = quotedResult
    ? quotedMedia.some((media) => media.type === 'video' || media.type === 'animated_gif')
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
    quotedTweetId: quotedResult?.restId ?? null,
    quotedTweetAuthorId: quotedResult?.user.restId ?? null,
    quotedTweetHasVideo,
    source: context.source,
  }
}
