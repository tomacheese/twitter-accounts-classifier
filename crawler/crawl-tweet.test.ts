import { describe, expect, it, vi } from 'vitest'
import { runManualTweetCrawl, type ManualTweetCrawlDependencies } from './crawl-tweet'

function rawUser(restId: string, screenName = 'someone') {
  return {
    restId,
    legacy: {
      screenName,
      name: 'Someone',
      description: null,
      followersCount: 1,
      friendsCount: 1,
      statusesCount: 1,
      createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
      profileImageUrlHttps: null,
      location: null,
      url: null,
    },
    isBlueVerified: true,
    verifiedType: null,
  }
}

function rawTweet(
  id: string,
  user: ReturnType<typeof rawUser>,
  inReplyToStatusIdStr: string | null = null,
) {
  return {
    restId: id,
    legacy: {
      fullText: 'hello',
      createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
      retweetCount: 5,
      favoriteCount: 5,
      replyCount: 0,
      quoteCount: 0,
      inReplyToStatusIdStr,
      retweetedStatusIdStr: null,
    },
    user,
  }
}

function makeDeps(
  overrides: Partial<ManualTweetCrawlDependencies> = {},
): ManualTweetCrawlDependencies {
  return {
    client: {
      getTweetApi: () => ({
        getHomeTimeline: vi.fn(),
        getHomeLatestTimeline: vi.fn(),
        getSearchTimeline: vi.fn(),
        getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [] } }),
      }),
      getUserApi: () => ({
        getUserByRestId: vi.fn().mockResolvedValue({ data: rawUser('parent1') }),
        getUserByScreenName: vi.fn(),
        getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
      }),
    },
    persistAccount: vi.fn().mockResolvedValue(undefined),
    persistTweets: vi.fn().mockResolvedValue(undefined),
    recentTweetsPerAccount: 20,
    ...overrides,
  }
}

describe('runManualTweetCrawl', () => {
  it('persists the focal tweet, its replies, and each reply author', async () => {
    const parentUser = rawUser('parent1')
    const replyUser1 = rawUser('reply1', 'replier1')
    const replyUser2 = rawUser('reply2', 'replier2')
    const focal = rawTweet('tweet1', parentUser)
    const reply1 = rawTweet('replyTweet1', replyUser1, 'tweet1')
    const reply2 = rawTweet('replyTweet2', replyUser2, 'tweet1')
    const unrelated = rawTweet('otherTweet', replyUser1, 'someOtherTweet')

    const getUserByRestId = vi
      .fn()
      .mockResolvedValueOnce({ data: parentUser })
      .mockResolvedValueOnce({ data: replyUser1 })
      .mockResolvedValueOnce({ data: replyUser2 })

    const deps = makeDeps({
      client: {
        getTweetApi: () => ({
          getHomeTimeline: vi.fn(),
          getHomeLatestTimeline: vi.fn(),
          getSearchTimeline: vi.fn(),
          getTweetDetail: vi
            .fn()
            .mockResolvedValue({ data: { data: [focal, reply1, reply2, unrelated] } }),
        }),
        getUserApi: () => ({
          getUserByRestId,
          getUserByScreenName: vi.fn(),
          getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
        }),
      },
    })

    const result = await runManualTweetCrawl(deps, 'tweet1')

    expect(result.repliesFound).toBe(2)
    expect(result.accountsProcessed).toBe(3)
    expect(deps.persistAccount).toHaveBeenCalledTimes(3)
    const persistedTweets = vi.mocked(deps.persistTweets).mock.calls[0][0]
    const persistedIds = persistedTweets.map((t) => t.id)
    expect(persistedIds).toEqual(expect.arrayContaining(['tweet1', 'replyTweet1', 'replyTweet2']))
    expect(persistedIds).not.toContain('otherTweet')
  })

  it('throws when the focal tweet is missing from the tweet-detail response', async () => {
    const deps = makeDeps()

    await expect(runManualTweetCrawl(deps, 'missingTweet')).rejects.toThrow(
      'Focal tweet missingTweet not found in tweet detail response',
    )
  })

  it('falls back to embedded profile data for an author whose profile fetch fails', async () => {
    const parentUser = rawUser('parent1')
    const replyUser1 = rawUser('reply1', 'replier1')
    const focal = rawTweet('tweet1', parentUser)
    const reply1 = rawTweet('replyTweet1', replyUser1, 'tweet1')

    const getUserByRestId = vi
      .fn()
      .mockResolvedValueOnce({ data: parentUser })
      .mockRejectedValueOnce(new Error('profile fetch failed'))

    const deps = makeDeps({
      client: {
        getTweetApi: () => ({
          getHomeTimeline: vi.fn(),
          getHomeLatestTimeline: vi.fn(),
          getSearchTimeline: vi.fn(),
          getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [focal, reply1] } }),
        }),
        getUserApi: () => ({
          getUserByRestId,
          getUserByScreenName: vi.fn(),
          getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
        }),
      },
    })

    const result = await runManualTweetCrawl(deps, 'tweet1')

    expect(result.accountsProcessed).toBe(1)
    const persistedAccountIds = vi.mocked(deps.persistAccount).mock.calls.map((call) => call[0].id)
    expect(persistedAccountIds).toEqual(expect.arrayContaining(['parent1', 'reply1']))
  })
})
