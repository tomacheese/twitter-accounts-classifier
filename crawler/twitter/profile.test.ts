import { describe, expect, it, vi } from 'vitest'
import { fetchAccountProfile, fetchRecentTweets, type UserApiLike } from './profile'
import type { RawTweetResult, RawUserResult } from './mappers'

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

function rawTweet(id: string): RawTweetResult {
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
    user: rawUser,
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
})
