import { describe, expect, it, vi } from 'vitest'
import type { AccountFeatureBundle } from '../types'
import * as textSimilarity from '../text-similarity'
import { replyFloodingRule } from './reply-flooding'

function makeBundle(
  tweets: {
    fullText: string
    isAuthorReply?: boolean
    minutesAgo?: number
    inReplyToTweetId?: string | null
  }[],
): AccountFeatureBundle {
  return {
    account: {
      id: 'author-1',
      screenName: 'fictional_author',
      displayName: 'Fictional Author',
      bio: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      isBlueVerified: false,
      verifiedType: null,
    },
    recentTweets: tweets.map((tweet, index) => ({
      id: `tweet-${index}`,
      fullText: tweet.fullText,
      createdAt: new Date(Date.now() - (tweet.minutesAgo ?? index) * 60_000),
      retweetCount: 0,
      likeCount: 0,
      isReply: true,
      isRetweet: false,
      isAuthorReply: tweet.isAuthorReply ?? false,
      inReplyToTweetId: tweet.inReplyToTweetId ?? 'parent-1',
      isPromoted: false,
      isPaidPromotion: false,
    })),
  }
}

describe('replyFloodingRule precision regressions', () => {
  it('excludes self-reply threads from flooding groups', () => {
    const bundle = makeBundle(
      Array.from({ length: 10 }, (_, index) => ({
        fullText: `続きのメモです ${index}`,
        isAuthorReply: true,
      })),
    )

    expect(replyFloodingRule.evaluate(bundle).value).toBe(false)
  })

  it('counts only non-author replies toward the eight-reply minimum', () => {
    const bundle = makeBundle([
      ...Array.from({ length: 7 }, (_, index) => ({
        fullText: `@target 同じ案内文を送ります ${index}`,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        fullText: `自己スレッドの追記 ${index}`,
        isAuthorReply: true,
      })),
    ])

    expect(replyFloodingRule.evaluate(bundle).value).toBe(false)
  })

  it('requires higher similarity for short live-commentary replies', () => {
    const similaritySpy = vi
      .spyOn(textSimilarity, 'averagePairwiseSimilarity')
      .mockReturnValue(0.15)

    try {
      const bundle = makeBundle(
        Array.from({ length: 8 }, (_, index) => ({
          fullText: `@target 実況${index}`,
        })),
      )
      expect(replyFloodingRule.evaluate(bundle).value).toBe(false)
    } finally {
      similaritySpy.mockRestore()
    }
  })

  it('keeps the low similarity threshold for long paraphrased or translated replies', () => {
    const similaritySpy = vi
      .spyOn(textSimilarity, 'averagePairwiseSimilarity')
      .mockReturnValue(0.07)

    try {
      const bundle = makeBundle(
        Array.from({ length: 8 }, (_, index) => ({
          fullText: `@target この作品はとても印象的で、細部まで何度も見返したくなります ${index}`,
        })),
      )
      expect(replyFloodingRule.evaluate(bundle).value).toBe(true)
    } finally {
      similaritySpy.mockRestore()
    }
  })

  it('still detects short near-identical flooding when similarity is high', () => {
    const similaritySpy = vi
      .spyOn(textSimilarity, 'averagePairwiseSimilarity')
      .mockReturnValue(0.35)

    try {
      const bundle = makeBundle(
        Array.from({ length: 8 }, (_, index) => ({
          fullText: `@target 了解です${index}`,
        })),
      )
      expect(replyFloodingRule.evaluate(bundle).value).toBe(true)
    } finally {
      similaritySpy.mockRestore()
    }
  })
})
