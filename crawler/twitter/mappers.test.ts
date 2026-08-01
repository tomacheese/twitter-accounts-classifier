import { describe, expect, it } from 'vitest'
import {
  toAccountProfileInput,
  toTweetInput,
  mergeTweetAdFlags,
  type RawTweetResult,
  type RawUserResult,
} from './mappers'
import type { TweetInput } from '../db/tweet-repository'

const rawUser: RawUserResult = {
  restId: 'u1',
  legacy: {
    screenName: 'test_user',
    name: 'Test User',
    description: 'a bio',
    followersCount: 10,
    friendsCount: 5,
    statusesCount: 100,
    createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
    profileImageUrlHttps: 'https://example.com/a.png',
    location: 'Tokyo',
    url: null,
  },
  isBlueVerified: true,
  verifiedType: null,
  professionalType: null,
  parodyCommentaryFanLabel: null,
}

const rawTweet: RawTweetResult = {
  restId: 't1',
  legacy: {
    fullText: 'hello',
    createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
    retweetCount: 3,
    favoriteCount: 10,
    replyCount: 1,
    quoteCount: 0,
    inReplyToStatusIdStr: null,
    retweetedStatusIdStr: null,
  },
  user: rawUser,
}

describe('toAccountProfileInput', () => {
  it('maps camelCase API fields to AccountProfileInput', () => {
    const input = toAccountProfileInput(rawUser)

    expect(input).toEqual({
      id: 'u1',
      screenName: 'test_user',
      displayName: 'Test User',
      bio: 'a bio',
      profileImageUrl: 'https://example.com/a.png',
      followersCount: 10,
      followingCount: 5,
      tweetCount: 100,
      accountCreatedAt: new Date('Wed Jan 01 00:00:00 +0000 2020'),
      location: 'Tokyo',
      url: null,
      isBlueVerified: true,
      verifiedType: null,
      professionalType: null,
      parodyCommentaryFanLabel: null,
    })
  })
})

describe('toTweetInput', () => {
  it('maps a normal (non-reply, non-retweet) tweet, tagging its source', () => {
    const input = toTweetInput(rawTweet, { source: 'recommended', viewerAccountId: 'someone-else' })

    expect(input).toEqual({
      id: 't1',
      accountId: 'u1',
      fullText: 'hello',
      createdAt: new Date('Wed Jan 01 00:00:00 +0000 2020'),
      retweetCount: 3,
      likeCount: 10,
      replyCount: 1,
      quoteCount: 0,
      isReply: false,
      inReplyToTweetId: null,
      isAuthorReply: false,
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
    })
  })

  it('defaults quotedTweetId, quotedTweetAuthorId and quotedTweetHasVideo to null when there is no quoted tweet', () => {
    const input = toTweetInput(rawTweet, { source: 'recommended', viewerAccountId: 'someone-else' })

    expect(input.quotedTweetId).toBeNull()
    expect(input.quotedTweetAuthorId).toBeNull()
    expect(input.quotedTweetHasVideo).toBeNull()
  })

  it('marks isAuthorReply true when the reply author matches the viewer account', () => {
    const replyTweet: RawTweetResult = {
      ...rawTweet,
      legacy: { ...rawTweet.legacy, inReplyToStatusIdStr: 'parent1' },
    }

    const input = toTweetInput(replyTweet, { source: 'recommended', viewerAccountId: 'u1' })

    expect(input.isReply).toBe(true)
    expect(input.inReplyToTweetId).toBe('parent1')
    expect(input.isAuthorReply).toBe(true)
  })

  it('defaults isPromoted and isPaidPromotion to false when absent from legacy', () => {
    const input = toTweetInput(rawTweet, { source: 'recommended', viewerAccountId: 'someone-else' })

    expect(input.isPromoted).toBe(false)
    expect(input.isPaidPromotion).toBe(false)
  })

  it('passes isPromoted and isPaidPromotion through when present in legacy', () => {
    const promotedTweet: RawTweetResult = {
      ...rawTweet,
      legacy: { ...rawTweet.legacy, isPromoted: true, isPaidPromotion: true },
    }

    const input = toTweetInput(promotedTweet, {
      source: 'recommended',
      viewerAccountId: 'someone-else',
    })

    expect(input.isPromoted).toBe(true)
    expect(input.isPaidPromotion).toBe(true)
  })

  it('defaults hasAiGeneratedMedia and aiGeneratedDetectionSource to null when absent from legacy', () => {
    const input = toTweetInput(rawTweet, { source: 'recommended', viewerAccountId: 'someone-else' })

    expect(input.hasAiGeneratedMedia).toBeNull()
    expect(input.aiGeneratedDetectionSource).toBeNull()
  })

  it('passes hasAiGeneratedMedia and aiGeneratedDetectionSource through when present in legacy', () => {
    const aiGeneratedTweet: RawTweetResult = {
      ...rawTweet,
      legacy: {
        ...rawTweet.legacy,
        hasAiGeneratedMedia: true,
        aiGeneratedDetectionSource: 'C2paClient',
      },
    }

    const input = toTweetInput(aiGeneratedTweet, {
      source: 'recommended',
      viewerAccountId: 'someone-else',
    })

    expect(input.hasAiGeneratedMedia).toBe(true)
    expect(input.aiGeneratedDetectionSource).toBe('C2paClient')
  })
})

function quotedStatusResult(mediaTypes: string[]): RawTweetResult['legacy']['quotedStatusResult'] {
  return {
    result: {
      restId: 'quoted1',
      legacy: {
        extendedEntities: {
          media: mediaTypes.map((type) => ({ type })),
        },
      },
      user: {
        restId: 'bob',
      },
    },
  }
}

describe('toTweetInput quoted tweet handling', () => {
  it('sets quotedTweetHasVideo to true when the quoted tweet has a video', () => {
    const quoteTweet: RawTweetResult = {
      ...rawTweet,
      legacy: { ...rawTweet.legacy, quotedStatusResult: quotedStatusResult(['video']) },
    }

    const input = toTweetInput(quoteTweet, {
      source: 'recommended',
      viewerAccountId: 'someone-else',
    })

    expect(input.quotedTweetId).toBe('quoted1')
    expect(input.quotedTweetAuthorId).toBe('bob')
    expect(input.quotedTweetHasVideo).toBe(true)
  })

  it('sets quotedTweetHasVideo to true when the quoted tweet has an animated GIF', () => {
    const quoteTweet: RawTweetResult = {
      ...rawTweet,
      legacy: { ...rawTweet.legacy, quotedStatusResult: quotedStatusResult(['animated_gif']) },
    }

    const input = toTweetInput(quoteTweet, {
      source: 'recommended',
      viewerAccountId: 'someone-else',
    })

    expect(input.quotedTweetHasVideo).toBe(true)
  })

  it('sets quotedTweetHasVideo to false when the quoted tweet only has photos', () => {
    const quoteTweet: RawTweetResult = {
      ...rawTweet,
      legacy: { ...rawTweet.legacy, quotedStatusResult: quotedStatusResult(['photo']) },
    }

    const input = toTweetInput(quoteTweet, {
      source: 'recommended',
      viewerAccountId: 'someone-else',
    })

    expect(input.quotedTweetId).toBe('quoted1')
    expect(input.quotedTweetAuthorId).toBe('bob')
    expect(input.quotedTweetHasVideo).toBe(false)
  })
})

function tweetInput(overrides: Partial<TweetInput> & { id: string }): TweetInput {
  return {
    accountId: 'u1',
    fullText: 'hello',
    createdAt: new Date('Wed Jan 01 00:00:00 +0000 2020'),
    retweetCount: 0,
    likeCount: 0,
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
    ...overrides,
  }
}

describe('mergeTweetAdFlags', () => {
  it('OR-merges isPromoted/isPaidPromotion across duplicate tweet ids, regardless of which copy comes last', () => {
    const merged = mergeTweetAdFlags([
      tweetInput({ id: 't1', isPromoted: true, isPaidPromotion: true }),
      tweetInput({ id: 't1', isPromoted: false, isPaidPromotion: false }),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 't1', isPromoted: true, isPaidPromotion: true })
  })

  it('leaves distinct tweet ids untouched', () => {
    const merged = mergeTweetAdFlags([tweetInput({ id: 't1' }), tweetInput({ id: 't2' })])

    expect(merged.map((t) => t.id)).toEqual(expect.arrayContaining(['t1', 't2']))
  })
})
