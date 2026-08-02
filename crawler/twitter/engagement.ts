import type { TweetApiUtils } from 'twitter-openapi-typescript'
import { toAccountProfileInput, toTweetInput, type RawTweetResult } from './mappers'
import { convertTimelineResponse } from './timeline'
import type { AccountProfileInput } from '../db/account-repository'
import type { TweetInput } from '../db/tweet-repository'

export function sortByEngagement(tweets: TweetInput[]): TweetInput[] {
  // eslint-disable-next-line unicorn/no-array-sort -- tsconfig のターゲットが ES2022 のため toSorted() は使えず、入力を変更しないようスプレッドしたコピーに sort() している
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
 * @param client - tweet detail API client
 * @param parentTweet - the tweet whose replies to fetch
 * @param limit - maximum number of replies to consider
 * @returns replies split into `authorReplies` and `otherReplies`, plus the replies' author profiles
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
 * `getTweetDetail` のレスポンス形状は `./timeline` の `createTweetApiLike` が変換する
 * timeline 系エンドポイントと同一のため、専用の変換処理を新設せず
 * {@link convertTimelineResponse} を流用する。
 * @param tweetApi - the real tweet API, e.g. from `TwitterOpenApiClient.getTweetApi()`
 * @returns a `TweetDetailApiLike` usable with {@link fetchReplies}
 */
export function createTweetDetailApiLike(tweetApi: TweetApiUtils): TweetDetailApiLike {
  return {
    getTweetDetail: (param) => convertTimelineResponse(tweetApi.getTweetDetail(param)),
  }
}
