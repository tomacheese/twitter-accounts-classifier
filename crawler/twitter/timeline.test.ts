import { describe, expect, it, vi } from 'vitest'
import {
  fetchRecommendedTimeline,
  fetchFollowingTimeline,
  fetchTrendingTimeline,
  type TweetApiLike,
  type TrendsScraperLike,
} from './timeline'
import type { RawTweetResult } from './mappers'

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
    user: {
      restId: `author-of-${id}`,
      legacy: {
        screenName: 'x',
        name: 'X',
        description: null,
        followersCount: 0,
        friendsCount: 0,
        statusesCount: 0,
        createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
        profileImageUrlHttps: null,
        location: null,
        url: null,
      },
      isBlueVerified: false,
      verifiedType: null,
      professionalType: null,
      parodyCommentaryFanLabel: null,
    },
  }
}

function page(
  ids: string[],
  cursor?: string,
  rawCount = ids.length,
): { data: { data: RawTweetResult[]; cursor?: string; rawCount: number } } {
  return { data: { data: ids.map((id) => rawTweet(id)), cursor, rawCount } }
}

describe('fetchRecommendedTimeline', () => {
  it('calls getHomeTimeline with the given count and tags results as recommended', async () => {
    const getHomeTimeline = vi.fn().mockResolvedValue(page(['1']))
    const client: TweetApiLike = {
      getHomeTimeline,
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline: vi.fn(),
    }

    const result = await fetchRecommendedTimeline(client, 20)

    expect(getHomeTimeline).toHaveBeenCalledWith({ count: 20, cursor: undefined })
    expect(result.tweets).toEqual([expect.objectContaining({ id: '1', source: 'recommended' })])
    expect(result.authors).toEqual([expect.objectContaining({ id: 'author-of-1' })])
  })

  it('is backward compatible with a single-page response (no cursor)', async () => {
    const getHomeTimeline = vi.fn().mockResolvedValue(page(['1', '2']))
    const client: TweetApiLike = {
      getHomeTimeline,
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline: vi.fn(),
    }

    const result = await fetchRecommendedTimeline(client, 20)

    expect(getHomeTimeline).toHaveBeenCalledTimes(1)
    expect(result.tweets).toHaveLength(2)
  })

  it('follows the returned cursor across multiple pages until limit is reached', async () => {
    const getHomeTimeline = vi
      .fn()
      .mockResolvedValueOnce(page(['1', '2'], 'cursor-a'))
      .mockResolvedValueOnce(page(['3', '4'], 'cursor-b'))
      .mockResolvedValueOnce(page(['5'], 'cursor-c'))
    const client: TweetApiLike = {
      getHomeTimeline,
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline: vi.fn(),
    }

    const result = await fetchRecommendedTimeline(client, 5)

    expect(getHomeTimeline).toHaveBeenCalledTimes(3)
    expect(getHomeTimeline).toHaveBeenNthCalledWith(1, { count: 5, cursor: undefined })
    expect(getHomeTimeline).toHaveBeenNthCalledWith(2, { count: 5, cursor: 'cursor-a' })
    expect(getHomeTimeline).toHaveBeenNthCalledWith(3, { count: 5, cursor: 'cursor-b' })
    expect(result.tweets.map((t) => t.id)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('stops paginating once the cursor is exhausted, even under the limit', async () => {
    const getHomeTimeline = vi
      .fn()
      .mockResolvedValueOnce(page(['1', '2'], 'cursor-a'))
      .mockResolvedValueOnce(page(['3'], undefined))
    const client: TweetApiLike = {
      getHomeTimeline,
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline: vi.fn(),
    }

    const result = await fetchRecommendedTimeline(client, 20)

    expect(getHomeTimeline).toHaveBeenCalledTimes(2)
    expect(result.tweets.map((t) => t.id)).toEqual(['1', '2', '3'])
  })

  it('truncates results to limit when the last page overshoots it', async () => {
    const getHomeTimeline = vi
      .fn()
      .mockResolvedValueOnce(page(['1', '2', '3'], 'cursor-a'))
      .mockResolvedValueOnce(page(['4', '5', '6'], 'cursor-b'))
    const client: TweetApiLike = {
      getHomeTimeline,
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline: vi.fn(),
    }

    const result = await fetchRecommendedTimeline(client, 5)

    expect(result.tweets).toHaveLength(5)
    expect(result.tweets.map((t) => t.id)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('keeps paginating past a page that filters down to zero mappable tweets as long as a cursor remains', async () => {
    // 広告・tombstone のみで構成され toRawTweetResult に全件除外されたページを再現している。
    // データ終端と誤認してはならないケース。
    const getHomeTimeline = vi
      .fn()
      .mockResolvedValueOnce(page([], 'cursor-a', 20))
      .mockResolvedValueOnce(page(['1', '2'], 'cursor-b'))
    const client: TweetApiLike = {
      getHomeTimeline,
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline: vi.fn(),
    }

    const result = await fetchRecommendedTimeline(client, 2)

    expect(getHomeTimeline).toHaveBeenCalledTimes(2)
    expect(getHomeTimeline).toHaveBeenNthCalledWith(2, { count: 2, cursor: 'cursor-a' })
    expect(result.tweets.map((t) => t.id)).toEqual(['1', '2'])
  })

  it('stops paginating when the raw page itself is genuinely empty, even with a cursor present', async () => {
    const getHomeTimeline = vi
      .fn()
      .mockResolvedValueOnce(page(['1'], 'cursor-a'))
      .mockResolvedValueOnce(page([], 'cursor-b', 0))
    const client: TweetApiLike = {
      getHomeTimeline,
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline: vi.fn(),
    }

    const result = await fetchRecommendedTimeline(client, 20)

    expect(getHomeTimeline).toHaveBeenCalledTimes(2)
    expect(result.tweets.map((t) => t.id)).toEqual(['1'])
  })

  it('stops paginating if the API returns the same cursor again (stuck-cursor guard)', async () => {
    const getHomeTimeline = vi.fn().mockResolvedValue(page([], 'same-cursor', 20))
    const client: TweetApiLike = {
      getHomeTimeline,
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline: vi.fn(),
    }

    const result = await fetchRecommendedTimeline(client, 20)

    expect(getHomeTimeline).toHaveBeenCalledTimes(2)
    expect(result.tweets).toEqual([])
  })
})

describe('fetchFollowingTimeline', () => {
  it('calls getHomeLatestTimeline and tags results as following', async () => {
    const getHomeLatestTimeline = vi.fn().mockResolvedValue(page(['2']))
    const client: TweetApiLike = {
      getHomeTimeline: vi.fn(),
      getHomeLatestTimeline,
      getSearchTimeline: vi.fn(),
    }

    const result = await fetchFollowingTimeline(client, 20)

    expect(getHomeLatestTimeline).toHaveBeenCalledWith({ count: 20, cursor: undefined })
    expect(result.tweets).toEqual([expect.objectContaining({ id: '2', source: 'following' })])
  })

  it('follows the returned cursor across multiple pages until limit is reached', async () => {
    const getHomeLatestTimeline = vi
      .fn()
      .mockResolvedValueOnce(page(['1', '2'], 'cursor-a'))
      .mockResolvedValueOnce(page(['3'], 'cursor-b'))
    const client: TweetApiLike = {
      getHomeTimeline: vi.fn(),
      getHomeLatestTimeline,
      getSearchTimeline: vi.fn(),
    }

    const result = await fetchFollowingTimeline(client, 3)

    expect(getHomeLatestTimeline).toHaveBeenCalledTimes(2)
    expect(result.tweets.map((t) => t.id)).toEqual(['1', '2', '3'])
  })
})

describe('fetchTrendingTimeline', () => {
  it('fetches trend names then searches for each, tagging results as trending', async () => {
    const getTrends = vi.fn().mockResolvedValue(['#foo', '#bar'])
    const scraper: TrendsScraperLike = { getTrends }
    const getSearchTimeline = vi.fn().mockResolvedValue(page(['3']))
    const client: TweetApiLike = {
      getHomeTimeline: vi.fn(),
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline,
    }

    const result = await fetchTrendingTimeline(scraper, client, 5, 10)

    expect(getTrends).toHaveBeenCalledTimes(1)
    expect(getSearchTimeline).toHaveBeenCalledWith({
      rawQuery: '#foo',
      product: 'Top',
      count: 5,
      cursor: undefined,
    })
    expect(getSearchTimeline).toHaveBeenCalledWith({
      rawQuery: '#bar',
      product: 'Top',
      count: 5,
      cursor: undefined,
    })
    expect(result.tweets.every((t) => t.source === 'trending')).toBe(true)
  })

  it('caps the number of trends consulted to maxTrends', async () => {
    const getTrends = vi.fn().mockResolvedValue(['#foo', '#bar', '#baz'])
    const scraper: TrendsScraperLike = { getTrends }
    const getSearchTimeline = vi.fn().mockResolvedValue(page([]))
    const client: TweetApiLike = {
      getHomeTimeline: vi.fn(),
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline,
    }

    await fetchTrendingTimeline(scraper, client, 5, 2)

    expect(getSearchTimeline).toHaveBeenCalledTimes(2)
  })

  it('paginates per-trend search results via cursor until limitPerTrend is reached', async () => {
    const getTrends = vi.fn().mockResolvedValue(['#foo'])
    const scraper: TrendsScraperLike = { getTrends }
    const getSearchTimeline = vi
      .fn()
      .mockResolvedValueOnce(page(['1', '2'], 'cursor-a'))
      .mockResolvedValueOnce(page(['3'], 'cursor-b'))
    const client: TweetApiLike = {
      getHomeTimeline: vi.fn(),
      getHomeLatestTimeline: vi.fn(),
      getSearchTimeline,
    }

    const result = await fetchTrendingTimeline(scraper, client, 3, 10)

    expect(getSearchTimeline).toHaveBeenCalledTimes(2)
    expect(getSearchTimeline).toHaveBeenNthCalledWith(2, {
      rawQuery: '#foo',
      product: 'Top',
      count: 3,
      cursor: 'cursor-a',
    })
    expect(result.tweets.map((t) => t.id)).toEqual(['1', '2', '3'])
  })
})
