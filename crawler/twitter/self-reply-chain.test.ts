import { describe, expect, it, vi } from 'vitest'
import { fetchSelfReplyChain } from './self-reply-chain'
import { TweetDetailRateLimitBudget } from './tweet-detail-rate-limit-budget'
import type { TweetInput } from '../db/tweet-repository'

function rawUser(restId: string, screenName = 'alice') {
  return {
    restId,
    legacy: {
      screenName,
      name: 'Alice',
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

function rawTweet(
  id: string,
  user: ReturnType<typeof rawUser>,
  inReplyToStatusIdStr: string | null,
) {
  return {
    restId: id,
    legacy: {
      fullText: 'これマジで見て',
      createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
      retweetCount: 0,
      favoriteCount: 0,
      replyCount: 0,
      quoteCount: 0,
      inReplyToStatusIdStr,
      retweetedStatusIdStr: null,
    },
    user,
  }
}

function startNode(id: string, accountId: string): TweetInput {
  return {
    id,
    accountId,
    fullText: 'これマジで見て',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    retweetCount: 0,
    likeCount: 0,
    replyCount: 0,
    quoteCount: 0,
    isReply: true,
    inReplyToTweetId: 'root1',
    isAuthorReply: true,
    isRetweet: false,
    retweetedTweetId: null,
    isPromoted: false,
    isPaidPromotion: false,
    hasAiGeneratedMedia: null,
    aiGeneratedDetectionSource: null,
    quotedTweetId: null,
    quotedTweetAuthorId: null,
    quotedTweetHasVideo: null,
    source: 'recommended',
  }
}

describe('fetchSelfReplyChain', () => {
  it('walks self-reply descendants across multiple TweetDetail calls', async () => {
    const alice = rawUser('alice1', 'alice')
    const bob = rawUser('bob1', 'bob')
    const getTweetDetail = vi
      .fn()
      // depth1 の直下: 自分の self-reply (depth2) と他人の返信 (辿らない)
      .mockResolvedValueOnce({
        data: {
          data: [rawTweet('depth2', alice, 'depth1'), rawTweet('otherReply', bob, 'depth1')],
        },
      })
      // depth2 の直下: 自分の self-reply (depth3)
      .mockResolvedValueOnce({ data: { data: [rawTweet('depth3', alice, 'depth2')] } })
      // depth3 の直下: これ以上 self-reply なし
      .mockResolvedValueOnce({ data: { data: [] } })
    const client = { getTweetDetail }
    const budget = new TweetDetailRateLimitBudget({ now: () => 0 })

    const result = await fetchSelfReplyChain(client, budget, startNode('depth1', 'alice1'), {
      maxDepth: 6,
      maxNodesPerRoot: 8,
    })

    expect(result.map((t) => t.id)).toEqual(['depth2', 'depth3'])
    expect(getTweetDetail).toHaveBeenCalledTimes(3)
  })

  it('stops at maxDepth', async () => {
    const alice = rawUser('alice1', 'alice')
    const getTweetDetail = vi.fn().mockImplementation(({ focalTweetId }) =>
      Promise.resolve({
        data: { data: [rawTweet(`${focalTweetId}-child`, alice, focalTweetId)] },
      }),
    )
    const client = { getTweetDetail }
    const budget = new TweetDetailRateLimitBudget({ now: () => 0 })

    const result = await fetchSelfReplyChain(client, budget, startNode('depth1', 'alice1'), {
      maxDepth: 2,
      maxNodesPerRoot: 100,
    })

    expect(result).toHaveLength(2)
  })

  it('stops at maxNodesPerRoot', async () => {
    const alice = rawUser('alice1', 'alice')
    const getTweetDetail = vi.fn().mockImplementation(({ focalTweetId }) =>
      Promise.resolve({
        data: { data: [rawTweet(`${focalTweetId}-child`, alice, focalTweetId)] },
      }),
    )
    const client = { getTweetDetail }
    const budget = new TweetDetailRateLimitBudget({ now: () => 0 })

    const result = await fetchSelfReplyChain(client, budget, startNode('depth1', 'alice1'), {
      maxDepth: 100,
      maxNodesPerRoot: 3,
    })

    expect(result.length).toBeLessThanOrEqual(3)
  })

  it('excludes replies from a different author', async () => {
    const bob = rawUser('bob1', 'bob')
    const getTweetDetail = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: [rawTweet('otherReply', bob, 'depth1')] } })
    const client = { getTweetDetail }
    const budget = new TweetDetailRateLimitBudget({ now: () => 0 })

    const result = await fetchSelfReplyChain(client, budget, startNode('depth1', 'alice1'), {
      maxDepth: 6,
      maxNodesPerRoot: 8,
    })

    expect(result).toEqual([])
  })

  it('returns partial results and stops when the rate-limit budget denies the fetch', async () => {
    const alice = rawUser('alice1', 'alice')
    const getTweetDetail = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: [rawTweet('depth2', alice, 'depth1')] } })
    const client = { getTweetDetail }
    // fallbackRequests: 1 で 2回目の acquireOptionalFetch() が 'budget_skipped' を返す状態を再現する。
    const budget = new TweetDetailRateLimitBudget({ now: () => 0, fallbackRequests: 1 })

    const result = await fetchSelfReplyChain(client, budget, startNode('depth1', 'alice1'), {
      maxDepth: 6,
      maxNodesPerRoot: 8,
    })

    expect(result.map((t) => t.id)).toEqual(['depth2'])
    expect(getTweetDetail).toHaveBeenCalledTimes(1)
  })
})
