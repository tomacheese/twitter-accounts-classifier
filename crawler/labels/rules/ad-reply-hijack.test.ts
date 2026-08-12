import { describe, expect, it } from 'vitest'
import { adReplyHijackRule } from './ad-reply-hijack'
import type { AccountFeatureBundle } from '../types'

function makeBundle(recentTweets: AccountFeatureBundle['recentTweets']): AccountFeatureBundle {
  return {
    account: {
      id: '1',
      screenName: 'x',
      displayName: 'X',
      bio: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      isBlueVerified: false,
      verifiedType: null,
    },
    recentTweets,
  }
}

function replyTweet(i: number, isAdPitch: boolean): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: `t${i}`,
    fullText: isAdPitch
      ? `@someone 今の職場に満足していますか？転職エージェントに無料相談してみませんか #転職 ${i}`
      : `@someone 同感です ${i}`,
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply: true,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
  }
}

function giveawayReplyTweet(i: number): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: `g${i}`,
    fullText: `@someone Congrats on the milestone! We're doing a giveaway, connect wallet and claim now #airdrop ${i}`,
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply: true,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
  }
}

describe('adReplyHijackRule', () => {
  it("is true when most of an account's replies are ad/job-change pitches", () => {
    const tweets = [
      replyTweet(1, true),
      replyTweet(2, true),
      replyTweet(3, true),
      replyTweet(4, false),
    ]
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('is false when replies rarely contain ad/job-change language', () => {
    const tweets = [
      replyTweet(1, false),
      replyTweet(2, false),
      replyTweet(3, false),
      replyTweet(4, true),
    ]
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it('is false when there are too few replies to judge (below the minimum sample size)', () => {
    const tweets = [replyTweet(1, true), replyTweet(2, true)]
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it("is true when most of an account's replies are crypto giveaway/airdrop pitches", () => {
    const tweets = [
      giveawayReplyTweet(1),
      giveawayReplyTweet(2),
      giveawayReplyTweet(3),
      replyTweet(4, false),
    ]
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('is false for benign replies with no ad, job-change, or giveaway/airdrop language', () => {
    const tweets = [
      replyTweet(1, false),
      replyTweet(2, false),
      replyTweet(3, false),
      replyTweet(4, false),
    ]
    const result = adReplyHijackRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it('is not evaluable when the reply sample is below the minimum', () => {
    const result = adReplyHijackRule.evaluate(makeBundle([]))
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })
})
