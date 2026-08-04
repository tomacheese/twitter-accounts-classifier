import type {
  TimelineApiUtilsResponse,
  TweetApiUtilsData,
  TwitterApiUtilsResponse,
  UserApiUtilsData,
  UserListApiUtils,
} from 'twitter-openapi-typescript'
import { toAccountProfileInput, type RawUserResult } from 'twitter-client'
import { toRawUserResult } from './timeline'
import type { AccountProfileInput } from '../db/account-repository'

/** `twitter-openapi-typescript` のフォロー API の 1 リクエスト上限が 200 件のため採用。 */
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
  /** アカウントごとに追加 API 呼び出しをする代わりに、一覧レスポンスから導出したプロフィール。 */
  authors: AccountProfileInput[]
  /**
   * カーソルが尽きて終了した場合のみ true。`limit` 到達やページ取得失敗では true にしない。
   * 呼び出し側はこの値でエッジ削除の可否を判断する。
   */
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
 * @param client - フォローリスト API アダプター
 * @param userId - フォロー一覧を取得する対象のアカウント
 * @param limit - この呼び出しで収集するエントリの最大件数
 * @returns 収集した id・プロフィールと、一覧の終端まで到達したかどうか
 */
export async function fetchFollowing(
  client: FollowListApiLike,
  userId: string,
  limit: number,
): Promise<FollowListResult> {
  return paginate((cursor) => client.getFollowing({ userId, cursor, count: PAGE_SIZE }), limit)
}

/**
 * @param client - フォローリスト API アダプター
 * @param userId - フォロワー一覧を取得する対象のアカウント
 * @param limit - この呼び出しで収集するエントリの最大件数
 * @returns 収集した id・プロフィールと、一覧の終端まで到達したかどうか
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
 * @param userListApi - 実際のユーザーリスト API (例: `TwitterOpenApiClient.getUserListApi()`)
 * @returns {@link fetchFollowing}・{@link fetchFollowers} で使う `FollowListApiLike`
 */
export function createFollowListApiLike(userListApi: UserListApiUtils): FollowListApiLike {
  return {
    getFollowing: (param) => convertFollowListResponse(userListApi.getFollowing(param)),
    getFollowers: (param) => convertFollowListResponse(userListApi.getFollowers(param)),
  }
}
