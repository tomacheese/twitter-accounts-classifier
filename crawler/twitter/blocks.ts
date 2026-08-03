import { toAccountProfileInput, type RawUserResult } from './mappers'
import type { BlocksListRawApiLike } from './blocks-client'
import type { AccountProfileInput } from '../db/account-repository'

/** `createBlocksClient` に渡すページサイズ。`follows.ts` の `PAGE_SIZE` と揃える。 */
const PAGE_SIZE = 200

export interface BlockListPage {
  data: RawUserResult[]
  nextCursor: string | undefined
}

export interface BlockListApiLike {
  getBlocks(param: { cursor?: string; count?: number }): Promise<BlockListPage>
}

export interface BlockListResult {
  ids: string[]
  authors: AccountProfileInput[]
  reachedEnd: boolean
}

async function paginate(
  fetchPage: (cursor: string | undefined) => Promise<BlockListPage>,
  limit: number,
): Promise<BlockListResult> {
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

  const truncated = ids.length > limit
  return {
    ids: ids.slice(0, limit),
    authors: authors.slice(0, limit),
    reachedEnd: reachedEnd && !truncated,
  }
}

/**
 * ログインアカウント自身がブロック中のユーザー一覧を取得する。
 * カーソルが尽きるか `limit` 件に達するまでページネーションする。
 * @param client - ブロック一覧 API のアダプター
 * @param limit - この呼び出しで収集する最大件数
 * @returns 収集した id・プロフィール、および一覧の末尾まで到達できたか
 */
export async function fetchBlocks(
  client: BlockListApiLike,
  limit: number,
): Promise<BlockListResult> {
  return paginate((cursor) => client.getBlocks({ cursor, count: PAGE_SIZE }), limit)
}

/**
 * {@link BlocksListRawApiLike} を `BlockListApiLike` にラップする。
 * @param rawApi - 内部エンドポイントへの生アクセス
 * @returns {@link fetchBlocks} で使える `BlockListApiLike`
 */
export function createBlockListApiLike(rawApi: BlocksListRawApiLike): BlockListApiLike {
  async function getBlocks(param?: { cursor?: string; count?: number }): Promise<BlockListPage> {
    const { cursor, count } = param ?? {}
    const result = await rawApi.getBlocksPage(cursor, count ?? PAGE_SIZE)
    return { data: result.users, nextCursor: result.nextCursor }
  }

  return { getBlocks }
}
