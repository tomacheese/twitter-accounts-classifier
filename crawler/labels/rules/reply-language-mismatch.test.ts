import { describe, expect, it } from 'vitest'
import { replyLanguageMismatchRule } from './reply-language-mismatch'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  accountOverrides: Partial<AccountFeatureBundle['account']>,
  recentTweets: AccountFeatureBundle['recentTweets'],
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
      ...accountOverrides,
    },
    recentTweets,
  }
}

function tweet(
  overrides: Partial<AccountFeatureBundle['recentTweets'][number]>,
): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: Math.random().toString(),
    fullText: 'hello',
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply: false,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
    ...overrides,
  }
}

describe('replyLanguageMismatchRule', () => {
  it('is true when own posts are non-Japanese but self-retweeted replies are Japanese', () => {
    const result = replyLanguageMismatchRule.evaluate(
      makeBundle({ screenName: 'example_user' }, [
        tweet({ fullText: 'Good night x lovers' }),
        tweet({ fullText: 'Good night sweet friends' }),
        tweet({ fullText: 'Almost bedtime, see you all tomorrow' }),
        tweet({
          fullText: 'RT @example_user: @alice その説は盲点だった…',
          isRetweet: true,
        }),
        tweet({
          fullText: 'RT @example_user: @bob これ続き絶対あるやつじゃん',
          isRetweet: true,
        }),
        tweet({
          fullText: 'RT @example_user: @carol そんなピンポイントで当たることある！？',
          isRetweet: true,
        }),
      ]),
    )
    expect(result.value).toBe(true)
  })

  it('is false when own posts and replies are in the same language', () => {
    const result = replyLanguageMismatchRule.evaluate(
      makeBundle({ screenName: 'x' }, [
        tweet({ fullText: '今日はいい天気ですね' }),
        tweet({ fullText: 'お昼ご飯なに食べようかな' }),
        tweet({ fullText: 'そろそろ寝ます' }),
        tweet({ fullText: '@a おはようございます！', isReply: true }),
        tweet({ fullText: '@b よろしくお願いします', isReply: true }),
        tweet({ fullText: '@c ありがとうございます', isReply: true }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('is false when the reply/self-retweet sample is too small', () => {
    const result = replyLanguageMismatchRule.evaluate(
      makeBundle({ screenName: 'example_user' }, [
        tweet({ fullText: 'Good night x lovers' }),
        tweet({ fullText: 'Good night sweet friends' }),
        tweet({ fullText: 'Almost bedtime, see you all tomorrow' }),
        tweet({
          fullText: 'RT @example_user: @alice その説は盲点だった…',
          isRetweet: true,
        }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it("is false for a plain retweet of someone else's content (not a self-retweeted reply)", () => {
    const result = replyLanguageMismatchRule.evaluate(
      makeBundle({ screenName: 'x' }, [
        tweet({ fullText: 'Good night x lovers' }),
        tweet({ fullText: 'Good night sweet friends' }),
        tweet({ fullText: 'Almost bedtime, see you all tomorrow' }),
        tweet({ fullText: 'RT @someone_else: 電車が止まるのはキツい', isRetweet: true }),
        tweet({ fullText: 'RT @someone_else: これ続き絶対あるやつじゃん', isRetweet: true }),
        tweet({ fullText: 'RT @someone_else: そんなピンポイントで', isRetweet: true }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('is false for plain replies that carry only a bare link and no actual reply text', () => {
    const result = replyLanguageMismatchRule.evaluate(
      makeBundle({ screenName: 'example_user' }, [
        tweet({ fullText: '今日はいい天気ですね' }),
        tweet({ fullText: 'お昼ご飯なに食べようかな' }),
        tweet({ fullText: 'そろそろ寝ます' }),
        tweet({ fullText: 'https://t.co/exampleAAAA', isReply: true }),
        tweet({ fullText: 'https://t.co/exampleBBBB', isReply: true }),
        tweet({ fullText: 'https://t.co/exampleCCCC', isReply: true }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('is false for link-only self-retweets, which carry no reply text at all', () => {
    const result = replyLanguageMismatchRule.evaluate(
      makeBundle({ screenName: 'example_user' }, [
        tweet({ fullText: '今夜21時からオンライン勉強会をやります' }),
        tweet({ fullText: '参加予約が1,000人を突破しました' }),
        tweet({ fullText: '本当に感謝しかありません' }),
        tweet({ fullText: 'RT @example_user: https://t.co/exampleDDDD', isRetweet: true }),
        tweet({ fullText: 'RT @example_user: https://t.co/exampleEEEE', isRetweet: true }),
        tweet({ fullText: 'RT @example_user: https://t.co/exampleFFFF', isRetweet: true }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('is not evaluable when either side has fewer samples than MIN_SAMPLE_PER_SIDE', () => {
    const result = replyLanguageMismatchRule.evaluate(makeBundle({}, []))
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })
})
