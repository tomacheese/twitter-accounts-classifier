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

/** Fetches 200 entries per page — the page size `twitter-openapi-typescript`'s follow-list endpoints accept per request. */
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
  /** Lightweight profiles of every discovered account, derived from the same list response (no extra per-account API call). */
  authors: AccountProfileInput[]
  /** True only if pagination stopped because the cursor was exhausted, not because `limit` was hit or a page fetch failed. Callers use this to decide whether it is safe to delete edges no longer present. */
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

  // A page can overshoot `limit` (a whole page is appended before the loop condition is
  // re-checked). If that same page also exhausted the cursor, `reachedEnd` above is true
  // even though the tail past `limit` is about to be discarded - the caller must not treat
  // those discarded ids as "gone" and prune their edges.
  const truncated = ids.length > limit
  return {
    ids: ids.slice(0, limit),
    authors: authors.slice(0, limit),
    reachedEnd: reachedEnd && !truncated,
  }
}

/**
 * Fetches the accounts a given account follows, paginating via cursor until either the
 * cursor is exhausted or `limit` total entries have been collected.
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
 * Fetches the accounts that follow a given account, paginating via cursor until either the
 * cursor is exhausted or `limit` total entries have been collected.
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
 * Wraps the real `twitter-openapi-typescript` user-list API (`client.getUserListApi()`)
 * into a `FollowListApiLike`, converting each response's `UserApiUtilsData[]` payload the
 * same way `./profile`'s `createUserApiLike` converts its own list responses.
 * @param userListApi - the real user-list API, e.g. from `TwitterOpenApiClient.getUserListApi()`
 * @returns a `FollowListApiLike` usable with {@link fetchFollowing} and {@link fetchFollowers}
 */
export function createFollowListApiLike(userListApi: UserListApiUtils): FollowListApiLike {
  return {
    getFollowing: (param) => convertFollowListResponse(userListApi.getFollowing(param)),
    getFollowers: (param) => convertFollowListResponse(userListApi.getFollowers(param)),
  }
}
