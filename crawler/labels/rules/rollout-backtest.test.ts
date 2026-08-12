import { describe, expect, it } from 'vitest'
import { botRule } from './bot'
import { spamRule } from './spam'
import { crossTargetTemplatedReplyRule } from './cross-target-templated-reply'
import type { AccountFeatureBundle } from '../types'

// data/config.json のデプロイ先固有設定に想定される confidenceThreshold との
// 境界での回帰を防ぐバックテスト。しきい値の実値はデプロイ時に運用者が
// 実際の data/config.json から確認すること (rollout チェックリスト参照)。
const BOT_CONFIDENCE_THRESHOLD = 0.5
const SPAM_CONFIDENCE_THRESHOLD = 0.5
const CROSS_TARGET_TEMPLATED_REPLY_CONFIDENCE_THRESHOLD = 0.7

describe('rollout backtest: bot gate boundary', () => {
  it('meets confidenceThreshold at the minimal value=true configuration (gate exactly)', () => {
    const now = new Date()
    const tweets: AccountFeatureBundle['recentTweets'] = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      fullText: `post ${i}`,
      createdAt: new Date(now.getTime() - (i * (1000 * 60 * 60 * 24)) / 300),
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
    }))
    const bundle: AccountFeatureBundle = {
      account: {
        id: '1',
        screenName: 'x',
        displayName: 'X',
        bio: null,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 45_050,
        accountCreatedAt: new Date(now.getTime() - 300 * 24 * 60 * 60 * 1000),
        isBlueVerified: false,
        verifiedType: null,
      },
      recentTweets: tweets,
    }
    const result = botRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThanOrEqual(BOT_CONFIDENCE_THRESHOLD)
  })
})

describe('rollout backtest: spam gate boundary', () => {
  it('meets confidenceThreshold at the minimal value=true configuration (gate exactly)', () => {
    const bundle: AccountFeatureBundle = {
      account: {
        id: '1',
        screenName: 'x',
        displayName: 'X',
        bio: '副業紹介します',
        followersCount: 100,
        followingCount: 500,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        isBlueVerified: false,
        verifiedType: null,
      },
      recentTweets: [],
    }
    const result = spamRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThanOrEqual(SPAM_CONFIDENCE_THRESHOLD)
  })
})

describe('rollout backtest: cross_target_templated_reply gate boundary', () => {
  it('does not clear confidenceThreshold at count=5 (unchanged from current production behavior)', () => {
    const now = new Date()
    const ownTweets: AccountFeatureBundle['recentTweets'] = Array.from({ length: 5 }, (_, i) => ({
      id: `own${i}`,
      fullText: `own post ${i}`,
      createdAt: now,
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
    }))
    const replyTweets: AccountFeatureBundle['recentTweets'] = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      fullText: '同じ賞賛文です本当にすごいと思いますとても感動しました',
      createdAt: now,
      retweetCount: 0,
      likeCount: 0,
      isReply: true,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: `target${i}`,
    }))
    const tweets: AccountFeatureBundle['recentTweets'] = [...ownTweets, ...replyTweets]
    const bundle: AccountFeatureBundle = {
      account: {
        id: '1',
        screenName: 'x',
        displayName: 'X',
        bio: null,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: now,
        isBlueVerified: false,
        verifiedType: null,
      },
      recentTweets: tweets,
    }
    const result = crossTargetTemplatedReplyRule.evaluate(bundle)
    expect(result.value).toBe(true)
    // count=5,6 は現行本番挙動でも通過しないことが分かっている既知の境界であり、
    // 本 PR による回帰ではない (count=7 以上で新旧の confidence がほぼ一致する)。
    expect(result.confidence).toBeLessThan(CROSS_TARGET_TEMPLATED_REPLY_CONFIDENCE_THRESHOLD)
  })

  it('meets confidenceThreshold at count=7', () => {
    const now = new Date()
    const tweets: AccountFeatureBundle['recentTweets'] = Array.from({ length: 7 }, (_, i) => ({
      id: `r${i}`,
      fullText: '同じ賞賛文です本当にすごいと思いますとても感動しました',
      createdAt: now,
      retweetCount: 0,
      likeCount: 0,
      isReply: true,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: `target${i}`,
    }))
    const bundle: AccountFeatureBundle = {
      account: {
        id: '1',
        screenName: 'x',
        displayName: 'X',
        bio: null,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: now,
        isBlueVerified: false,
        verifiedType: null,
      },
      recentTweets: tweets,
    }
    const result = crossTargetTemplatedReplyRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThanOrEqual(
      CROSS_TARGET_TEMPLATED_REPLY_CONFIDENCE_THRESHOLD,
    )
  })
})
