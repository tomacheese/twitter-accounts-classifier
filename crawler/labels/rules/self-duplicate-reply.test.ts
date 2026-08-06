import { describe, expect, it } from 'vitest'
import { selfDuplicateReplyRule } from './self-duplicate-reply'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  tweets: {
    fullText: string
    isReply?: boolean
    isRetweet?: boolean
    inReplyToTweetId?: string | null
  }[],
): AccountFeatureBundle {
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
    recentTweets: tweets.map((t, i) => ({
      id: `t${i}`,
      fullText: t.fullText,
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: t.isReply ?? false,
      isRetweet: t.isRetweet ?? false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: t.inReplyToTweetId,
    })),
  }
}

describe('selfDuplicateReplyRule', () => {
  it('is true when the same content recurs as both a standalone tweet and a reply at least twice', () => {
    const bundle = makeBundle([
      { fullText: 'これはとても素晴らしい情報ですね！ぜひ拡散をお願いします', isReply: false },
      {
        fullText: '@target これはとても素晴らしい情報ですね！ぜひ拡散をお願いします',
        isReply: true,
      },
      { fullText: 'This is really wonderful information, please spread it', isReply: false },
      {
        fullText: '@target This is really wonderful information, please spread it',
        isReply: true,
      },
    ])

    const result = selfDuplicateReplyRule.evaluate(bundle)

    expect(result.value).toBe(true)
  })

  it('is false when the duplicate standalone/reply pattern occurs only once', () => {
    const bundle = makeBundle([
      { fullText: 'これはとても素晴らしい情報ですね！ぜひ拡散をお願いします', isReply: false },
      {
        fullText: '@target これはとても素晴らしい情報ですね！ぜひ拡散をお願いします',
        isReply: true,
      },
    ])

    const result = selfDuplicateReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false for an account whose replies never duplicate a standalone tweet', () => {
    const bundle = makeBundle([
      { fullText: 'これはとても素晴らしい情報ですね！ぜひ拡散をお願いします', isReply: false },
      { fullText: '@target 全然違う内容の返信です、重複していません', isReply: true },
    ])

    const result = selfDuplicateReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('ignores retweets when looking for duplicate standalone/reply pairs', () => {
    const bundle = makeBundle([
      {
        fullText: 'これはとても素晴らしい情報ですね！ぜひ拡散をお願いします',
        isReply: false,
        isRetweet: true,
      },
      {
        fullText: '@target これはとても素晴らしい情報ですね！ぜひ拡散をお願いします',
        isReply: true,
      },
    ])

    const result = selfDuplicateReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false when the duplicate reply is thread narration replying to the account’s own tweet, not someone else’s', () => {
    const bundle = makeBundle([
      { fullText: '会場に到着しました、これから配信を始めます', isReply: false },
      {
        fullText: '会場に到着しました、これから配信を始めます',
        isReply: true,
        inReplyToTweetId: 't0',
      },
      { fullText: 'この後のセットリストを発表します、お楽しみに', isReply: false },
      {
        fullText: 'この後のセットリストを発表します、お楽しみに',
        isReply: true,
        inReplyToTweetId: 't0',
      },
    ])

    const result = selfDuplicateReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is true when two external duplicate pairs exist alongside an excluded self-thread duplicate', () => {
    const bundle = makeBundle([
      { fullText: '会場に到着しました、これから配信を始めます', isReply: false },
      {
        fullText: '会場に到着しました、これから配信を始めます',
        isReply: true,
        inReplyToTweetId: 't0',
      },
      { fullText: 'これはとても素晴らしい情報ですね！ぜひ拡散をお願いします', isReply: false },
      {
        fullText: '@target これはとても素晴らしい情報ですね！ぜひ拡散をお願いします',
        isReply: true,
        inReplyToTweetId: 'someone-elses-tweet',
      },
      { fullText: 'This is really wonderful information, please spread it', isReply: false },
      {
        fullText: '@target This is really wonderful information, please spread it',
        isReply: true,
        inReplyToTweetId: 'someone-elses-tweet',
      },
    ])

    const result = selfDuplicateReplyRule.evaluate(bundle)

    expect(result.value).toBe(true)
  })

  it('is false when only one external duplicate pair exists alongside an excluded self-thread duplicate', () => {
    const bundle = makeBundle([
      { fullText: '会場に到着しました、これから配信を始めます', isReply: false },
      {
        fullText: '会場に到着しました、これから配信を始めます',
        isReply: true,
        inReplyToTweetId: 't0',
      },
      { fullText: 'これはとても素晴らしい情報ですね！ぜひ拡散をお願いします', isReply: false },
      {
        fullText: '@target これはとても素晴らしい情報ですね！ぜひ拡散をお願いします',
        isReply: true,
        inReplyToTweetId: 'someone-elses-tweet',
      },
    ])

    const result = selfDuplicateReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })
})
