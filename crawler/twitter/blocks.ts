import { toAccountProfileInput, type RawUserResult } from 'twitter-client'
import type { BlocksListRawApiLike } from './blocks-client'
import type { AccountProfileInput } from '../db/account-repository'

/** `getBlocks` に渡すページサイズ。`follows.ts` の `PAGE_SIZE` と揃える。 */
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
  /**
   * カーソルが尽きたことで停止した場合のみ true。
   * `limit` に達した、またはページ取得が失敗したことで停止した場合は false。
   * 呼び出し側はこの値を見て、現存しない `blockedId` の行を削除してよいかどうかを判断する。
   */
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

  // limit に達したページがたまたまカーソル終端でもあった場合、末尾を切り捨てた分を呼び出し側の prune 処理に「もう存在しない」と誤解されないよう reachedEnd を false にする。
  const truncated = ids.length > limit
  return {
    ids: ids.slice(0, limit),
    authors: authors.slice(0, limit),
    reachedEnd: reachedEnd && !truncated,
  }
}

/**
 * @param client - ブロック一覧 API のアダプター
 * @param limit - この呼び出しで収集する最大件数
 * @returns 収集した id・プロフィール、および一覧の末尾まで到達できたか (詳細は {@link BlockListResult.reachedEnd} を参照)
 */
export async function fetchBlocks(
  client: BlockListApiLike,
  limit: number,
): Promise<BlockListResult> {
  return paginate((cursor) => client.getBlocks({ cursor, count: PAGE_SIZE }), limit)
}

/**
 * `count` 未指定時に `PAGE_SIZE` をデフォルト値として補うことで、`fetchBlocks` 以外の呼び出し元 (テストなど) が毎回ページサイズを指定しなくても済むようにする。
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
