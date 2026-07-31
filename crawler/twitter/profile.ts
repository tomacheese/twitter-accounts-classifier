import type { TweetApiUtils, TwitterApiUtilsResponse, UserApiUtils, UserApiUtilsData } from 'twitter-openapi-typescript'
import { toAccountProfileInput, toTweetInput, type RawTweetResult, type RawUserResult } from './mappers'
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

export async function fetchAccountProfile(client: UserApiLike, userId: string): Promise<AccountProfileInput> {
  const response = await client.getUserByRestId({ userId })
  return toAccountProfileInput(response.data)
}

export interface RecentTweetsResult {
  tweets: TweetInput[]
  /** Profiles of every tweet author appearing in the response, e.g. other users pulled in via conversation context (no extra API calls). */
  authors: AccountProfileInput[]
}

export async function fetchRecentTweets(
  client: UserApiLike,
  userId: string,
  limit: number,
): Promise<RecentTweetsResult> {
  const response = await client.getUserTweetsAndReplies({ userId, count: limit })
  return {
    tweets: response.data.data.map((raw) => toTweetInput(raw, { source: 'profile', viewerAccountId: userId })),
    authors: response.data.data.map((raw) => toAccountProfileInput(raw.user)),
  }
}

/**
 * Awaits a real `twitter-openapi-typescript` `getUserByRestId` response and converts its
 * `UserApiUtilsData` payload into `{ data: RawUserResult }`, reusing `./timeline`'s
 * `toRawUserResult`. `UserApiUtilsData.user` is `i.User | undefined` (unlike
 * `TweetApiUtilsData.user`, which is never undefined) because the lookup can target a
 * suspended or deleted account, hence the explicit throw.
 * @param response - the pending `getUserByRestId`/`getUserByScreenName` response
 * @returns the converted user payload
 * @throws if the lookup returned no user, e.g. a suspended or deleted account
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
 * Wraps the real `twitter-openapi-typescript` user API (`client.getUserApi()`) and tweet
 * API (`client.getTweetApi()`) into a `UserApiLike`. `getUserByRestId` is declared on
 * `UserApiUtils` and returns `TwitterApiUtilsResponse<UserApiUtilsData>` (converted via
 * {@link convertUserResponse}); `getUserTweetsAndReplies` is declared on `TweetApiUtils`
 * and shares the exact same `TwitterApiUtilsResponse<TimelineApiUtilsResponse<TweetApiUtilsData>>`
 * shape as the timeline/tweet-detail endpoints, so it reuses `./timeline`'s
 * `convertTimelineResponse`.
 * @param userApi - the real user API, e.g. from `TwitterOpenApiClient.getUserApi()`
 * @param tweetApi - the real tweet API, e.g. from `TwitterOpenApiClient.getTweetApi()`
 * @returns a `UserApiLike` usable with {@link fetchAccountProfile} and {@link fetchRecentTweets}
 */
export function createUserApiLike(userApi: UserApiUtils, tweetApi: TweetApiUtils): UserApiLike {
  return {
    getUserByRestId: (param) => convertUserResponse(userApi.getUserByRestId(param)),
    getUserByScreenName: (param) => convertUserResponse(userApi.getUserByScreenName(param)),
    getUserTweetsAndReplies: (param) => convertTimelineResponse(tweetApi.getUserTweetsAndReplies(param)),
  }
}
