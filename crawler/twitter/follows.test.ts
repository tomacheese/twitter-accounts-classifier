import { describe, expect, it, vi } from 'vitest'
import type { TwitterApiUtilsResponse, UserListApiUtils } from 'twitter-openapi-typescript'
import {
  createFollowListApiLike,
  fetchFollowers,
  fetchFollowing,
  type FollowListApiLike,
  type FollowListPage,
} from './follows'
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

function page(ids: string[], nextCursor: string | undefined): FollowListPage {
  return { data: ids.map((id) => rawUser(id)), nextCursor }
}

describe('fetchFollowing', () => {
  it('follows the cursor across pages until exhausted, marking reachedEnd true', async () => {
    const getFollowing = vi
      .fn()
      .mockResolvedValueOnce(page(['1', '2'], 'cursor-a'))
      .mockResolvedValueOnce(page(['3'], undefined))
    const client: FollowListApiLike = {
      getFollowing,
      getFollowers: vi.fn(),
    }

    const result = await fetchFollowing(client, 'me', 100)

    expect(result.ids).toEqual(['1', '2', '3'])
    expect(result.authors.map((a) => a.id)).toEqual(['1', '2', '3'])
    expect(result.reachedEnd).toBe(true)
    expect(getFollowing).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: 'me', cursor: undefined }),
    )
    expect(getFollowing).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userId: 'me', cursor: 'cursor-a' }),
    )
  })

  it('stops at the limit without exhausting the cursor, marking reachedEnd false', async () => {
    const getFollowing = vi
      .fn()
      .mockResolvedValueOnce(page(['1', '2'], 'cursor-a'))
      .mockResolvedValueOnce(page(['3', '4'], 'cursor-b'))
    const client: FollowListApiLike = { getFollowing, getFollowers: vi.fn() }

    const result = await fetchFollowing(client, 'me', 3)

    expect(result.ids).toEqual(['1', '2', '3'])
    expect(result.reachedEnd).toBe(false)
  })

  it('treats an empty page as the end of the list', async () => {
    const getFollowing = vi.fn().mockResolvedValueOnce(page([], 'cursor-a'))
    const client: FollowListApiLike = { getFollowing, getFollowers: vi.fn() }

    const result = await fetchFollowing(client, 'me', 100)

    expect(result.ids).toEqual([])
    expect(result.reachedEnd).toBe(true)
  })

  it('propagates a page-fetch failure without catching it, so the caller decides how to handle it', async () => {
    const getFollowing = vi.fn().mockRejectedValue(new Error('rate limited'))
    const client: FollowListApiLike = { getFollowing, getFollowers: vi.fn() }

    await expect(fetchFollowing(client, 'me', 100)).rejects.toThrow('rate limited')
  })

  it('marks reachedEnd false when the cursor-exhausting page also overshoots the limit', async () => {
    // limit 超過分として破棄される末尾の id は、
    // 呼び出し側の prune 処理で「もう存在しない」と誤判定されてはならない。
    const getFollowing = vi.fn().mockResolvedValueOnce(page(['1', '2', '3'], undefined))
    const client: FollowListApiLike = { getFollowing, getFollowers: vi.fn() }

    const result = await fetchFollowing(client, 'me', 2)

    expect(result.ids).toEqual(['1', '2'])
    expect(result.reachedEnd).toBe(false)
  })
})

function apiResponse(users: (RawUserResult | undefined)[], bottomCursor: string | undefined) {
  return Promise.resolve({
    data: {
      data: users.map((user) => ({
        user: user && {
          restId: user.restId,
          legacy: user.legacy,
          isBlueVerified: user.isBlueVerified,
          verifiedType: user.verifiedType,
        },
      })),
      cursor: { bottom: bottomCursor === undefined ? undefined : { value: bottomCursor } },
    },
  }) as unknown as Promise<TwitterApiUtilsResponse<never>>
}

describe('createFollowListApiLike', () => {
  it('extracts ids/profiles and the next cursor from a real getFollowing response shape', async () => {
    const userListApi = {
      getFollowing: vi.fn().mockReturnValue(apiResponse([rawUser('1')], 'cursor-a')),
      getFollowers: vi.fn(),
    } as unknown as UserListApiUtils
    const client = createFollowListApiLike(userListApi)

    const result = await client.getFollowing({ userId: 'me' })

    expect(result.data.map((u) => u.restId)).toEqual(['1'])
    expect(result.nextCursor).toBe('cursor-a')
  })

  it('drops entries with no user payload and reports no next cursor when cursor.bottom is absent', async () => {
    const userListApi = {
      getFollowing: vi.fn(),
      getFollowers: vi.fn().mockReturnValue(apiResponse([rawUser('9'), undefined], undefined)),
    } as unknown as UserListApiUtils
    const client = createFollowListApiLike(userListApi)

    const result = await client.getFollowers({ userId: 'me' })

    expect(result.data.map((u) => u.restId)).toEqual(['9'])
    expect(result.nextCursor).toBeUndefined()
  })
})

describe('fetchFollowers', () => {
  it('paginates the followers endpoint the same way as following', async () => {
    const getFollowers = vi.fn().mockResolvedValueOnce(page(['9'], undefined))
    const client: FollowListApiLike = { getFollowing: vi.fn(), getFollowers }

    const result = await fetchFollowers(client, 'me', 100)

    expect(result.ids).toEqual(['9'])
    expect(result.reachedEnd).toBe(true)
    expect(getFollowers).toHaveBeenCalledWith(expect.objectContaining({ userId: 'me' }))
  })
})
