import { describe, expect, it, vi } from 'vitest'
import { runManualTweetCrawl, type ManualTweetCrawlDependencies } from './crawl-tweet'
import { TweetDetailRateLimitBudget } from './twitter/tweet-detail-rate-limit-budget'

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
    recordRecentTweetsFetchSuccess: vi.fn().mockResolvedValue(undefined),
    recordRecentTweetsFetchFailure: vi.fn().mockResolvedValue(undefined),
    requestAccountRelabel: vi.fn().mockResolvedValue(undefined),
    recentTweetsPerAccount: 20,
    repliesPerTweet: 30,
    tweetDetailRateLimitBudget: new TweetDetailRateLimitBudget({ now: () => 0 }),
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

  it('deepens a self-reply that links to a third-party X status via fetchSelfReplyChain', async () => {
    const parentUser = rawUser('parent1')
    const focal = rawTweet('tweet1', parentUser)
    const selfReply = {
      restId: 'replyTweet1',
      legacy: {
        fullText: 'これマジで見て',
        createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
        retweetCount: 0,
        favoriteCount: 0,
        replyCount: 0,
        quoteCount: 0,
        inReplyToStatusIdStr: 'tweet1',
        retweetedStatusIdStr: null,
        entities: {
          urls: [{ url: 'https://t.co/a', expandedUrl: 'https://x.com/other_creator/status/1' }],
        },
      },
      user: parentUser,
    }
    const depth2SelfReply = {
      restId: 'replyTweet1-child',
      legacy: {
        fullText: 'これも見て',
        createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
        retweetCount: 0,
        favoriteCount: 0,
        replyCount: 0,
        quoteCount: 0,
        inReplyToStatusIdStr: 'replyTweet1',
        retweetedStatusIdStr: null,
      },
      user: parentUser,
    }

    const getTweetDetail = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: [focal, selfReply] } })
      // fetchReplies が同じ focalTweetId で再度呼ばれる (manual スクリプトは低頻度実行のため許容する)
      .mockResolvedValueOnce({ data: { data: [focal, selfReply] } })
      // fetchSelfReplyChain: replyTweet1 を focalTweetId とした深掘り
      .mockResolvedValueOnce({ data: { data: [depth2SelfReply] } })
      .mockResolvedValueOnce({ data: { data: [] } })

    const deps = makeDeps({
      client: {
        getTweetApi: () => ({
          getHomeTimeline: vi.fn(),
          getHomeLatestTimeline: vi.fn(),
          getSearchTimeline: vi.fn(),
          getTweetDetail,
        }),
        getUserApi: () => ({
          getUserByRestId: vi.fn().mockResolvedValue({ data: parentUser }),
          getUserByScreenName: vi.fn(),
          getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
        }),
      },
      repliesPerTweet: 30,
      tweetDetailRateLimitBudget: new TweetDetailRateLimitBudget({ now: () => 0 }),
    })

    const result = await runManualTweetCrawl(deps, 'tweet1')

    const persistedIds = vi.mocked(deps.persistTweets).mock.calls[0][0].map((t) => t.id)
    expect(persistedIds).toEqual(expect.arrayContaining(['replyTweet1', 'replyTweet1-child']))
    expect(result.repliesFound).toBe(1)
  })

  it('requests account_relabel for the focal author and every processed reply author, including new accounts, after persisting tweets', async () => {
    const parentUser = rawUser('parent1')
    const replyUser1 = rawUser('reply1', 'replier1')
    const replyUser2 = rawUser('reply2', 'replier2')
    const focal = rawTweet('tweet1', parentUser)
    const reply1 = rawTweet('replyTweet1', replyUser1, 'tweet1')
    const reply2 = rawTweet('replyTweet2', replyUser2, 'tweet1')

    const callOrder: string[] = []
    const persistTweets = vi.fn().mockImplementation(() => {
      callOrder.push('persistTweets')
      return Promise.resolve()
    })
    const requestAccountRelabel = vi.fn().mockImplementation(() => {
      callOrder.push('requestAccountRelabel')
      return Promise.resolve()
    })

    const deps = makeDeps({
      client: {
        getTweetApi: () => ({
          getHomeTimeline: vi.fn(),
          getHomeLatestTimeline: vi.fn(),
          getSearchTimeline: vi.fn(),
          getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [focal, reply1, reply2] } }),
        }),
        getUserApi: () => ({
          getUserByRestId: vi
            .fn()
            .mockResolvedValueOnce({ data: parentUser })
            .mockResolvedValueOnce({ data: replyUser1 })
            .mockResolvedValueOnce({ data: replyUser2 }),
          getUserByScreenName: vi.fn(),
          getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
        }),
      },
      persistTweets,
      requestAccountRelabel,
    })

    await runManualTweetCrawl(deps, 'tweet1')

    expect(requestAccountRelabel).toHaveBeenCalledTimes(1)
    const requestedIds = requestAccountRelabel.mock.calls[0][0] as string[]
    expect(new Set(requestedIds)).toEqual(new Set(['parent1', 'reply1', 'reply2']))
    expect(callOrder).toEqual(['persistTweets', 'requestAccountRelabel'])
  })

  it('records success recent-tweets fetch status for an author whose recent-tweets fetch succeeds', async () => {
    const parentUser = rawUser('parent1')
    const focal = rawTweet('tweet1', parentUser)

    const recordRecentTweetsFetchSuccess = vi.fn().mockResolvedValue(undefined)
    const recordRecentTweetsFetchFailure = vi.fn().mockResolvedValue(undefined)

    const deps = makeDeps({
      client: {
        getTweetApi: () => ({
          getHomeTimeline: vi.fn(),
          getHomeLatestTimeline: vi.fn(),
          getSearchTimeline: vi.fn(),
          getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [focal] } }),
        }),
        getUserApi: () => ({
          getUserByRestId: vi.fn().mockResolvedValue({ data: parentUser }),
          getUserByScreenName: vi.fn(),
          getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
        }),
      },
      recordRecentTweetsFetchSuccess,
      recordRecentTweetsFetchFailure,
    })

    await runManualTweetCrawl(deps, 'tweet1')

    expect(recordRecentTweetsFetchSuccess).toHaveBeenCalledWith('parent1', expect.any(Date))
    expect(recordRecentTweetsFetchFailure).not.toHaveBeenCalled()
  })

  it('records failed recent-tweets fetch status when recent-tweets fetch fails after profile fetch succeeded', async () => {
    const parentUser = rawUser('parent1')
    const focal = rawTweet('tweet1', parentUser)

    const recordRecentTweetsFetchSuccess = vi.fn().mockResolvedValue(undefined)
    const recordRecentTweetsFetchFailure = vi.fn().mockResolvedValue(undefined)

    const deps = makeDeps({
      client: {
        getTweetApi: () => ({
          getHomeTimeline: vi.fn(),
          getHomeLatestTimeline: vi.fn(),
          getSearchTimeline: vi.fn(),
          getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [focal] } }),
        }),
        getUserApi: () => ({
          getUserByRestId: vi.fn().mockResolvedValue({ data: parentUser }),
          getUserByScreenName: vi.fn(),
          getUserTweetsAndReplies: vi.fn().mockRejectedValue(new Error('recent tweets failed')),
        }),
      },
      recordRecentTweetsFetchSuccess,
      recordRecentTweetsFetchFailure,
    })

    await runManualTweetCrawl(deps, 'tweet1')

    expect(recordRecentTweetsFetchFailure).toHaveBeenCalledWith('parent1', expect.any(Date))
    expect(recordRecentTweetsFetchSuccess).not.toHaveBeenCalled()
  })

  it('does not record a recent-tweets fetch failure when the profile fetch itself fails', async () => {
    const parentUser = rawUser('parent1')
    const focal = rawTweet('tweet1', parentUser)

    const recordRecentTweetsFetchSuccess = vi.fn().mockResolvedValue(undefined)
    const recordRecentTweetsFetchFailure = vi.fn().mockResolvedValue(undefined)

    const deps = makeDeps({
      client: {
        getTweetApi: () => ({
          getHomeTimeline: vi.fn(),
          getHomeLatestTimeline: vi.fn(),
          getSearchTimeline: vi.fn(),
          getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [focal] } }),
        }),
        getUserApi: () => ({
          getUserByRestId: vi.fn().mockRejectedValue(new Error('profile fetch failed')),
          getUserByScreenName: vi.fn(),
          getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
        }),
      },
      recordRecentTweetsFetchSuccess,
      recordRecentTweetsFetchFailure,
    })

    await runManualTweetCrawl(deps, 'tweet1')

    expect(recordRecentTweetsFetchFailure).not.toHaveBeenCalled()
    expect(recordRecentTweetsFetchSuccess).not.toHaveBeenCalled()
  })

  it('records the recent-tweets success timestamp taken after the fetch resolves, not the pre-fetch attempted timestamp', async () => {
    const parentUser = rawUser('parent1')
    const focal = rawTweet('tweet1', parentUser)
    const recordRecentTweetsFetchSuccess = vi.fn().mockResolvedValue(undefined)

    vi.useFakeTimers()
    const attemptedAt = new Date('2024-01-01T00:00:00.000Z')
    vi.setSystemTime(attemptedAt)
    const fetchedAt = new Date(attemptedAt.getTime() + 5000)

    const deps = makeDeps({
      client: {
        getTweetApi: () => ({
          getHomeTimeline: vi.fn(),
          getHomeLatestTimeline: vi.fn(),
          getSearchTimeline: vi.fn(),
          getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [focal] } }),
        }),
        getUserApi: () => ({
          getUserByRestId: vi.fn().mockResolvedValue({ data: parentUser }),
          getUserByScreenName: vi.fn(),
          getUserTweetsAndReplies: vi.fn().mockImplementation(() => {
            vi.setSystemTime(fetchedAt)
            return Promise.resolve({ data: { data: [] } })
          }),
        }),
      },
      recordRecentTweetsFetchSuccess,
    })

    try {
      await runManualTweetCrawl(deps, 'tweet1')
    } finally {
      vi.useRealTimers()
    }

    expect(recordRecentTweetsFetchSuccess).toHaveBeenCalledWith('parent1', fetchedAt)
  })

  it('propagates a recent-tweets success-status persistence failure without recording it as a fetch failure', async () => {
    const parentUser = rawUser('parent1')
    const focal = rawTweet('tweet1', parentUser)

    const recordRecentTweetsFetchSuccess = vi.fn().mockRejectedValue(new Error('db write failed'))
    const recordRecentTweetsFetchFailure = vi.fn().mockResolvedValue(undefined)

    const deps = makeDeps({
      client: {
        getTweetApi: () => ({
          getHomeTimeline: vi.fn(),
          getHomeLatestTimeline: vi.fn(),
          getSearchTimeline: vi.fn(),
          getTweetDetail: vi.fn().mockResolvedValue({ data: { data: [focal] } }),
        }),
        getUserApi: () => ({
          getUserByRestId: vi.fn().mockResolvedValue({ data: parentUser }),
          getUserByScreenName: vi.fn(),
          getUserTweetsAndReplies: vi.fn().mockResolvedValue({ data: { data: [] } }),
        }),
      },
      recordRecentTweetsFetchSuccess,
      recordRecentTweetsFetchFailure,
    })

    await expect(runManualTweetCrawl(deps, 'tweet1')).rejects.toThrow('db write failed')
    expect(recordRecentTweetsFetchFailure).not.toHaveBeenCalled()
  })
})
