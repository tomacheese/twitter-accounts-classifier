import type {
  TimelineApiUtilsResponse,
  TweetApiUtilsData,
  TwitterApiUtilsResponse,
  UserApiUtilsData,
  UserListApiUtils,
} from 'twitter-openapi-typescript'
import { toAccountProfileInput, type RawUserResult } from './mappers'
import { toRawUserResult } from './timeline'
import type { AccountProfileInput } from '../db/account-repository'

/** `twitter-openapi-typescript` のフォローリスト系エンドポイントが 1 リクエストで受け付ける上限が 200 件のため、この値を採用する。 */
const PAGE_SIZE = 200

export interface FollowListPage {
  data: RawUserResult[]
  nextCursor: string | undefined
}

export interface FollowListApiLike {
  getFollowing(param: { userId: string; cursor?: string; count?: number }): Promise<FollowListPage>
  getFollowers(param: { userId: string; cursor?: string; count?: number }): Promise<FollowListPage>
}

export interface FollowListResult {
  ids: string[]
  /** アカウントごとに追加 API 呼び出しをして取得する代わりに、同一の一覧レスポンスから導出したプロフィール。 */
  authors: AccountProfileInput[]
  /** カーソルが尽きて終了した場合のみ true。`limit` 到達やページ取得失敗による終了では true にしない。呼び出し側はこの値でエッジ削除の可否を判断する。 */
  reachedEnd: boolean
}

async function paginate(
  fetchPage: (cursor: string | undefined) => Promise<FollowListPage>,
  limit: number,
): Promise<FollowListResult> {
  const ids: string[] = []
  const authors: AccountProfileInput[] = []
  let cursor: string | undefined
  let reachedEnd = false

  while (ids.length < limit) {
    const page = await fetchPage(cursor)
    for (const raw of page.data) {
      ids.push(raw.restId)
      authors.push(toAccountProfileInput(raw))
    }
    if (!page.nextCursor || page.data.length === 0) {
      reachedEnd = true
      break
    }
    cursor = page.nextCursor
  }

  // limit を超過した末尾は破棄するため、
  // そのページでカーソルが尽きていても reachedEnd を true のままにはしない。
  // 破棄した id を呼び出し側が「もう存在しない」と誤判定してエッジを削除しないようにするため。
  const truncated = ids.length > limit
  return {
    ids: ids.slice(0, limit),
    authors: authors.slice(0, limit),
    reachedEnd: reachedEnd && !truncated,
  }
}

/**
 * @param client - the follow-list API adapter
 * @param userId - the account whose following list is fetched
 * @param limit - the maximum number of entries to collect this call
 * @returns the collected ids/profiles and whether the full list was reached
 */
export async function fetchFollowing(
  client: FollowListApiLike,
  userId: string,
  limit: number,
): Promise<FollowListResult> {
  return paginate((cursor) => client.getFollowing({ userId, cursor, count: PAGE_SIZE }), limit)
}

/**
 * @param client - the follow-list API adapter
 * @param userId - the account whose follower list is fetched
 * @param limit - the maximum number of entries to collect this call
 * @returns the collected ids/profiles and whether the full list was reached
 */
export async function fetchFollowers(
  client: FollowListApiLike,
  userId: string,
  limit: number,
): Promise<FollowListResult> {
  return paginate((cursor) => client.getFollowers({ userId, cursor, count: PAGE_SIZE }), limit)
}

async function convertFollowListResponse(
  response: Promise<TwitterApiUtilsResponse<TimelineApiUtilsResponse<UserApiUtilsData>>>,
): Promise<FollowListPage> {
  const result = await response
  return {
    data: result.data.data
      .map((entry) => entry.user)
      .filter((user): user is TweetApiUtilsData['user'] => user !== undefined)
      .map((user) => toRawUserResult(user)),
    nextCursor: result.data.cursor.bottom?.value,
  }
}

/**
 * @param userListApi - the real user-list API, e.g. from `TwitterOpenApiClient.getUserListApi()`
 * @returns a `FollowListApiLike` usable with {@link fetchFollowing} and {@link fetchFollowers}
 */
export function createFollowListApiLike(userListApi: UserListApiUtils): FollowListApiLike {
  return {
    getFollowing: (param) => convertFollowListResponse(userListApi.getFollowing(param)),
    getFollowers: (param) => convertFollowListResponse(userListApi.getFollowers(param)),
  }
}
