import type {
  TweetApiUtils,
  TwitterApiUtilsResponse,
  UserApiUtils,
  UserApiUtilsData,
} from 'twitter-openapi-typescript'
import {
  toAccountProfileInput,
  toTweetInput,
  type RawTweetResult,
  type RawUserResult,
} from './mappers'
import { convertTimelineResponse, toRawUserResult } from './timeline'
import type { AccountProfileInput } from '../db/account-repository'
import type { TweetInput } from '../db/tweet-repository'

export interface UserApiLike {
  getUserByRestId(param: { userId: string }): Promise<{ data: RawUserResult }>
  getUserByScreenName(param: { screenName: string }): Promise<{ data: RawUserResult }>
  getUserTweetsAndReplies(param: { userId: string; count?: number }): Promise<{
    data: { data: RawTweetResult[] }
  }>
}

export async function fetchAccountProfile(
  client: UserApiLike,
  userId: string,
): Promise<AccountProfileInput> {
  const response = await client.getUserByRestId({ userId })
  return toAccountProfileInput(response.data)
}

export interface RecentTweetsResult {
  tweets: TweetInput[]
  /** レスポンスに含まれる全ツイート投稿者のプロフィール (会話コンテキスト経由で紛れ込む他ユーザーなど)。追加の API 呼び出しは発生しない。 */
  authors: AccountProfileInput[]
}

export async function fetchRecentTweets(
  client: UserApiLike,
  userId: string,
  limit: number,
): Promise<RecentTweetsResult> {
  const response = await client.getUserTweetsAndReplies({ userId, count: limit })
  return {
    tweets: response.data.data.map((raw) =>
      toTweetInput(raw, { source: 'profile', viewerAccountId: userId }),
    ),
    authors: response.data.data.map((raw) => toAccountProfileInput(raw.user)),
  }
}

/**
 * 実際の `twitter-openapi-typescript` の `getUserByRestId` レスポンスを待って `UserApiUtilsData` を `{ data: RawUserResult }` に変換する。
 * 変換ロジックを重複させないよう `./timeline` の `toRawUserResult` を再利用する。
 * `UserApiUtilsData.user` は (常に存在する `TweetApiUtilsData.user` と異なり) `i.User | undefined` であり、
 * 停止・削除済みアカウントを検索対象にし得るため、
 * 明示的に throw している。
 * @param response - `getUserByRestId`・`getUserByScreenName` の保留中レスポンス
 * @returns 変換後のユーザーペイロード
 * @throws 検索結果がユーザーなしだった場合。例: 停止・削除済みアカウント
 */
async function convertUserResponse(
  response: Promise<TwitterApiUtilsResponse<UserApiUtilsData>>,
): Promise<{ data: RawUserResult }> {
  const result = await response
  if (!result.data.user) {
    throw new Error('User not found')
  }
  return { data: toRawUserResult(result.data.user) }
}

/**
 * 実際の `twitter-openapi-typescript` のユーザー API (`client.getUserApi()`) とツイート API (`client.getTweetApi()`) を `UserApiLike` にラップする。
 * `getUserByRestId` は `UserApiUtils` に宣言され `TwitterApiUtilsResponse<UserApiUtilsData>` を返すため {@link convertUserResponse} で変換する。
 * `getUserTweetsAndReplies` は `TweetApiUtils` に宣言されており、
 * timeline・tweet-detail 系エンドポイントと全く同じ `TwitterApiUtilsResponse<TimelineApiUtilsResponse<TweetApiUtilsData>>` 形状を返すため、
 * 専用の変換処理を新設せず `./timeline` の `convertTimelineResponse` を再利用する。
 * @param userApi - 実際のユーザー API (例: `TwitterOpenApiClient.getUserApi()`)
 * @param tweetApi - 実際のツイート API (例: `TwitterOpenApiClient.getTweetApi()`)
 * @returns {@link fetchAccountProfile}・{@link fetchRecentTweets} で使う `UserApiLike`
 */
export function createUserApiLike(userApi: UserApiUtils, tweetApi: TweetApiUtils): UserApiLike {
  return {
    getUserByRestId: (param) => convertUserResponse(userApi.getUserByRestId(param)),
    getUserByScreenName: (param) => convertUserResponse(userApi.getUserByScreenName(param)),
    getUserTweetsAndReplies: (param) =>
      convertTimelineResponse(tweetApi.getUserTweetsAndReplies(param)),
  }
}
