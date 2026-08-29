import { describe, expect, it, vi } from 'vitest'
import { fetchAccountProfile, fetchRecentTweets, type UserApiLike } from './profile'
import type { RawTweetResult, RawUserResult } from 'twitter-client'

const rawUser: RawUserResult = {
  restId: 'u1',
  legacy: {
    screenName: 'test_user',
    name: 'Test User',
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

const foreignUser: RawUserResult = {
  ...rawUser,
  restId: 'stranger1',
  legacy: { ...rawUser.legacy, screenName: 'stranger' },
}

function rawTweet(id: string, user: RawUserResult = rawUser): RawTweetResult {
  return {
    restId: id,
    legacy: {
      fullText: `tweet ${id}`,
      createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
      retweetCount: 0,
      favoriteCount: 0,
      replyCount: 0,
      quoteCount: 0,
      inReplyToStatusIdStr: null,
      retweetedStatusIdStr: null,
    },
    user,
  }
}

describe('fetchAccountProfile', () => {
  it('fetches by user id and maps to AccountProfileInput', async () => {
    const getUserByRestId = vi.fn().mockResolvedValue({ data: rawUser })
    const client: UserApiLike = {
      getUserByRestId,
      getUserByScreenName: vi.fn(),
      getUserTweetsAndReplies: vi.fn(),
    }

    const profile = await fetchAccountProfile(client, 'u1')

    expect(getUserByRestId).toHaveBeenCalledWith({ userId: 'u1' })
    expect(profile.id).toBe('u1')
    expect(profile.screenName).toBe('test_user')
  })
})

describe('fetchRecentTweets', () => {
  it('fetches user tweets and replies, tagged with source "profile"', async () => {
    const getUserTweetsAndReplies = vi
      .fn()
      .mockResolvedValue({ data: { data: [rawTweet('1'), rawTweet('2')] } })
    const client: UserApiLike = {
      getUserByRestId: vi.fn(),
      getUserByScreenName: vi.fn(),
      getUserTweetsAndReplies,
    }

    const { tweets, authors } = await fetchRecentTweets(client, 'u1', 20)

    expect(getUserTweetsAndReplies).toHaveBeenCalledWith({ userId: 'u1', count: 20 })
    expect(tweets).toHaveLength(2)
    expect(tweets[0].source).toBe('profile')
    expect(authors).toEqual([
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({ id: 'u1' }),
    ])
  })

  it('keeps the requested user own reply alongside a reply-thread foreign context tweet', async () => {
    const getUserTweetsAndReplies = vi.fn().mockResolvedValue({
      data: { data: [rawTweet('own-reply1', rawUser), rawTweet('parent1', foreignUser)] },
    })
    const client: UserApiLike = {
      getUserByRestId: vi.fn(),
      getUserByScreenName: vi.fn(),
      getUserTweetsAndReplies,
    }

    const { tweets } = await fetchRecentTweets(client, 'u1', 20)

    expect(tweets.map((t) => t.id)).toEqual(expect.arrayContaining(['own-reply1', 'parent1']))
    expect(tweets.find((t) => t.id === 'own-reply1')?.accountId).toBe('u1')
    expect(tweets.find((t) => t.id === 'parent1')?.accountId).toBe('stranger1')
  })

  it('throws when the response is non-empty but contains no tweet authored by the requested user', async () => {
    // getUserTweetsAndReplies が返信スレッドの文脈 tweet だけで埋まり、
    // 本人の tweet/reply が 1 件も解釈できない場合、
    // 誤った recent-tweet 状態を success として永続化させてはならない。
    const getUserTweetsAndReplies = vi.fn().mockResolvedValue({
      data: { data: [rawTweet('parent1', foreignUser), rawTweet('parent2', foreignUser)] },
    })
    const client: UserApiLike = {
      getUserByRestId: vi.fn(),
      getUserByScreenName: vi.fn(),
      getUserTweetsAndReplies,
    }

    await expect(fetchRecentTweets(client, 'u1', 20)).rejects.toThrow(/u1/)
  })

  it('resolves with an empty result for a genuinely empty timeline instead of throwing', async () => {
    const getUserTweetsAndReplies = vi.fn().mockResolvedValue({ data: { data: [] } })
    const client: UserApiLike = {
      getUserByRestId: vi.fn(),
      getUserByScreenName: vi.fn(),
      getUserTweetsAndReplies,
    }

    const { tweets, authors } = await fetchRecentTweets(client, 'u1', 20)

    expect(tweets).toEqual([])
    expect(authors).toEqual([])
  })
})
