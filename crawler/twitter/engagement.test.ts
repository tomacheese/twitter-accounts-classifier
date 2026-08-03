import { describe, expect, it, vi } from 'vitest'
import { sortByEngagement, fetchReplies, type TweetDetailApiLike } from './engagement'
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
