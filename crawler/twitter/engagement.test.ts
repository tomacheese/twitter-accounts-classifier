import { describe, expect, it, vi } from 'vitest'
import {
  sortByEngagement,
  fetchReplies,
  fetchParentTweet,
  type TweetDetailApiLike,
} from './engagement'
import type { TweetInput } from '../db/tweet-repository'
import type { RawTweetResult } from 'twitter-client'

function tweet(id: string, retweetCount: number, likeCount: number): TweetInput {
  return {
    id,
    accountId: 'author1',
    fullText: `tweet ${id}`,
    createdAt: new Date(),
    retweetCount,
    likeCount,
    replyCount: 0,
    quoteCount: 0,
    isReply: false,
    inReplyToTweetId: null,
    isAuthorReply: false,
    isRetweet: false,
    retweetedTweetId: null,
    isPromoted: false,
    isPaidPromotion: false,
    hasAiGeneratedMedia: false,
    aiGeneratedDetectionSource: null,
    quotedTweetId: null,
    quotedTweetAuthorId: null,
    quotedTweetHasVideo: null,
    source: 'recommended',
  }
}

describe('sortByEngagement', () => {
  it('sorts descending by retweetCount + likeCount', () => {
    const tweets = [tweet('low', 1, 1), tweet('high', 10, 10), tweet('mid', 5, 5)]

    const sorted = sortByEngagement(tweets)

    expect(sorted.map((t) => t.id)).toEqual(['high', 'mid', 'low'])
  })
})

function rawReply(id: string, authorId: string, parentId: string): RawTweetResult {
  return {
    restId: id,
    legacy: {
      fullText: `reply ${id}`,
      createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
      retweetCount: 0,
      favoriteCount: 0,
      replyCount: 0,
      quoteCount: 0,
      inReplyToStatusIdStr: parentId,
      retweetedStatusIdStr: null,
    },
    user: {
      restId: authorId,
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

describe('fetchReplies', () => {
  it('splits replies into author replies and other replies', async () => {
    const getTweetDetail = vi.fn().mockResolvedValue({
      data: {
        data: [rawReply('r1', 'author1', 'parent1'), rawReply('r2', 'someone-else', 'parent1')],
      },
    })
    const client: TweetDetailApiLike = { getTweetDetail }
    const parent = tweet('parent1', 0, 0)

    const { authorReplies, otherReplies, authors } = await fetchReplies(client, parent, 10)

    expect(getTweetDetail).toHaveBeenCalledWith({ focalTweetId: 'parent1' })
    expect(authorReplies.map((t) => t.id)).toEqual(['r1'])
    expect(otherReplies.map((t) => t.id)).toEqual(['r2'])
    expect(authors.map((a) => a.id)).toEqual(['author1', 'someone-else'])
  })
})

describe('fetchParentTweet', () => {
  it('returns the tweet and author matching the requested parent id', async () => {
    const parentRaw = {
      restId: 'parent1',
      legacy: { fullText: 'parent post', inReplyToStatusIdStr: null },
      user: { restId: 'parentAuthor1', legacy: { screenName: 'parent_author' } },
    } as unknown as RawTweetResult
    const otherRaw = {
      restId: 'sibling1',
      legacy: { fullText: 'unrelated tweet', inReplyToStatusIdStr: null },
      user: { restId: 'someoneElse', legacy: { screenName: 'someone_else' } },
    } as unknown as RawTweetResult
    const getTweetDetail = vi.fn().mockResolvedValue({ data: { data: [parentRaw, otherRaw] } })
    const client: TweetDetailApiLike = { getTweetDetail }

    const result = await fetchParentTweet(client, 'parent1')

    expect(getTweetDetail).toHaveBeenCalledWith({ focalTweetId: 'parent1' })
    expect(result?.tweet.id).toBe('parent1')
    expect(result?.author.id).toBe('parentAuthor1')
  })

  it('returns undefined when the parent id is not present in the response', async () => {
    const otherRaw = {
      restId: 'sibling1',
      legacy: { fullText: 'unrelated tweet', inReplyToStatusIdStr: null },
      user: { restId: 'someoneElse', legacy: { screenName: 'someone_else' } },
    } as unknown as RawTweetResult
    const getTweetDetail = vi.fn().mockResolvedValue({ data: { data: [otherRaw] } })
    const client: TweetDetailApiLike = { getTweetDetail }

    const result = await fetchParentTweet(client, 'missing-parent')

    expect(result).toBeUndefined()
  })
})
