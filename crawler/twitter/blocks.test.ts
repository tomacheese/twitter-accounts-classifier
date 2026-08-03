import { describe, expect, it, vi } from 'vitest'
import {
  createBlockListApiLike,
  fetchBlocks,
  type BlockListApiLike,
  type BlockListPage,
} from './blocks'
import type { BlocksListRawApiLike } from './blocks-client'
import type { RawUserResult } from './mappers'

function rawUser(restId: string): RawUserResult {
  return {
    restId,
    legacy: {
      screenName: `user_${restId}`,
      name: `User ${restId}`,
      description: null,
      followersCount: 1,
      friendsCount: 1,
      statusesCount: 1,
      createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
      profileImageUrlHttps: null,
      location: null,
      url: null,
    },
    isBlueVerified: false,
    verifiedType: null,
    professionalType: null,
    parodyCommentaryFanLabel: null,
  }
}

function page(ids: string[], nextCursor: string | undefined): BlockListPage {
  return { data: ids.map((id) => rawUser(id)), nextCursor }
}

describe('fetchBlocks', () => {
  it('follows the cursor across pages until exhausted, marking reachedEnd true', async () => {
    const getBlocks = vi
      .fn()
      .mockResolvedValueOnce(page(['1', '2'], 'cursor-a'))
      .mockResolvedValueOnce(page(['3'], undefined))
    const client: BlockListApiLike = { getBlocks }

    const result = await fetchBlocks(client, 100)

    expect(result.ids).toEqual(['1', '2', '3'])
    expect(result.authors.map((a) => a.id)).toEqual(['1', '2', '3'])
    expect(result.reachedEnd).toBe(true)
  })

  it('stops at the limit without exhausting the cursor, marking reachedEnd false', async () => {
    const getBlocks = vi
      .fn()
      .mockResolvedValueOnce(page(['1', '2'], 'cursor-a'))
      .mockResolvedValueOnce(page(['3', '4'], 'cursor-b'))
    const client: BlockListApiLike = { getBlocks }

    const result = await fetchBlocks(client, 3)

    expect(result.ids).toEqual(['1', '2', '3'])
    expect(result.reachedEnd).toBe(false)
  })

  it('treats an empty page as the end of the list', async () => {
    const getBlocks = vi.fn().mockResolvedValueOnce(page([], 'cursor-a'))
    const client: BlockListApiLike = { getBlocks }

    const result = await fetchBlocks(client, 100)

    expect(result.ids).toEqual([])
    expect(result.reachedEnd).toBe(true)
  })

  it('propagates a page-fetch failure without catching it, so the caller decides how to handle it', async () => {
    const getBlocks = vi.fn().mockRejectedValue(new Error('rate limited'))
    const client: BlockListApiLike = { getBlocks }

    await expect(fetchBlocks(client, 100)).rejects.toThrow('rate limited')
  })
})

describe('createBlockListApiLike', () => {
  it('wraps the raw blocks client into a BlockListApiLike, forwarding cursor/count', async () => {
    const getBlocksPage = vi
      .fn()
      .mockResolvedValue({ users: [rawUser('1')], nextCursor: 'cursor-a' })
    const rawApi: BlocksListRawApiLike = { getBlocksPage }
    const client = createBlockListApiLike(rawApi)

    const result = await client.getBlocks({ cursor: 'prev-cursor', count: 200 })

    expect(result.data.map((u) => u.restId)).toEqual(['1'])
    expect(result.nextCursor).toBe('cursor-a')
    expect(getBlocksPage).toHaveBeenCalledWith('prev-cursor', 200)
  })
})
