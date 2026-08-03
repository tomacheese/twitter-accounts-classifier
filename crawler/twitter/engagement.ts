import type { TweetApiUtils } from 'twitter-openapi-typescript'
import { toAccountProfileInput, toTweetInput, type RawTweetResult } from 'twitter-client'
import { convertTimelineResponse } from './timeline'
import type { AccountProfileInput } from '../db/account-repository'
import type { TweetInput } from '../db/tweet-repository'

export function sortByEngagement(tweets: TweetInput[]): TweetInput[] {
  // eslint-disable-next-line unicorn/no-array-sort -- ES2022 では toSorted() 不可、コピーに sort()
  return [...tweets].sort((a, b) => b.retweetCount + b.likeCount - (a.retweetCount + a.likeCount))
}

export interface TweetDetailApiLike {
  getTweetDetail(param: { focalTweetId: string }): Promise<{ data: { data: RawTweetResult[] } }>
}

export interface RepliesResult {
  authorReplies: TweetInput[]
  otherReplies: TweetInput[]
  /** 返信者ごとに追加の API 呼び出しを行う代わりに、同一レスポンスから導出したプロフィール。 */
  authors: AccountProfileInput[]
}

/**
 * @param client - ツイート詳細 API クライアント
 * @param parentTweet - 返信を取得する対象のツイート
 * @param limit - 考慮する返信の最大件数
 * @returns `authorReplies` と `otherReplies` に分けた返信、および返信者のプロフィール
 */
export async function fetchReplies(
  client: TweetDetailApiLike,
  parentTweet: TweetInput,
  limit: number,
): Promise<RepliesResult> {
  const response = await client.getTweetDetail({ focalTweetId: parentTweet.id })
  const rawReplies = response.data.data
    .filter((raw) => raw.legacy.inReplyToStatusIdStr === parentTweet.id)
    .slice(0, limit)
  const replies = rawReplies.map((raw) =>
    toTweetInput(raw, { source: parentTweet.source, viewerAccountId: parentTweet.accountId }),
  )

  return {
    authorReplies: replies.filter((r) => r.isAuthorReply),
    otherReplies: replies.filter((r) => !r.isAuthorReply),
    authors: rawReplies.map((raw) => toAccountProfileInput(raw.user)),
  }
}

/**
 * `getTweetDetail` の形状は `./timeline` が変換する timeline 系エンドポイントと同一のため、
 * 専用の変換処理を新設せず {@link convertTimelineResponse} を流用する。
 * @param tweetApi - 実際のツイート API (例: `TwitterOpenApiClient.getTweetApi()`)
 * @returns {@link fetchReplies} で使う `TweetDetailApiLike`
 */
export function createTweetDetailApiLike(tweetApi: TweetApiUtils): TweetDetailApiLike {
  return {
    getTweetDetail: (param) => convertTimelineResponse(tweetApi.getTweetDetail(param)),
  }
}
