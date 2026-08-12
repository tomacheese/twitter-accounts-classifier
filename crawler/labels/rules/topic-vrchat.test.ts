import { describe, expect, it } from 'vitest'
import { topicVrchatRule } from './topic-vrchat'
import type { AccountFeatureBundle } from '../types'

function buildBundle(
  bio: string | null,
  tweets: { fullText: string; isRetweet?: boolean }[] = [],
): AccountFeatureBundle {
  return {
    account: {
      id: '1',
      screenName: 'test_user',
      displayName: 'Test User',
      bio,
      followersCount: 0,
      followingCount: 0,
      tweetCount: tweets.length,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: false,
      verifiedType: null,
    },
    recentTweets: tweets.map(({ fullText, isRetweet = false }, index) => ({
      id: String(index),
      fullText,
      createdAt: new Date('2020-01-01T00:00:00Z'),
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet,
      isPromoted: false,
      isPaidPromotion: false,
    })),
  }
}

describe('topicVrchatRule', () => {
  it('bio に VRChat を含む場合は value: true になる', () => {
    const bundle = buildBundle('VRChat が趣味です。よろしくお願いします。')
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.8)
  })

  it('bio に前後を英数字で挟まれていない VRC を含む場合は value: true になる', () => {
    const bundle = buildBundle('VRC を始めました！よろしくお願いします。')
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(true)
  })

  it('bio にアンダースコア区切りのハンドル名メンションを含む場合は value: true になる', () => {
    const bundle = buildBundle('フレンドはこちら → @example_VRC')
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(true)
  })

  it('bio にアンダースコアが後続するハンドル名メンションを含む場合は value: true になる', () => {
    const bundle = buildBundle('フレンドはこちら → @VRC_example')
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(true)
  })

  it('bio に俗称「ぶいちゃ」を含む場合は value: true になる', () => {
    const bundle = buildBundle('ぶいちゃ勢です。よろしくお願いします。')
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(true)
  })

  it('bio に連結表記 VRCID を含む場合は value: true になる', () => {
    const bundle = buildBundle('VRCID:example')
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(true)
  })

  it('bio は無関係だが直近ツイートに VRChat を含む場合は value: true になる', () => {
    const bundle = buildBundle('猫が好きです。', [
      { fullText: '今日は友達と VRChat で遊びました！' },
    ])
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(true)
  })

  it('bio・ツイートのいずれにも VRChat 関連キーワードを含まない場合は value: false になる', () => {
    const bundle = buildBundle('猫が好きです。', [{ fullText: '今日はカフェに行きました。' }])
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(1)
  })

  it('VRC の前後が英数字である場合は value: false になる (誤検知防止の境界ケース)', () => {
    const bundle = buildBundle('xVRCy ABCVRC VRC123 のテスト文字列です。')
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })

  it('bio が null かつツイートにも VRChat キーワードがない場合は value: false になる', () => {
    const bundle = buildBundle(null, [{ fullText: '今日はカフェに行きました。' }])
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })

  it('VRChat キーワードを含むツイートがリツイートである場合は value: false になる (他アカウントの発言のため)', () => {
    const bundle = buildBundle('猫が好きです。', [
      { fullText: '今日は友達と VRChat で遊びました！', isRetweet: true },
    ])
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })

  it('「ぶいちゃん」のように直後に「ん」が続く場合は value: false になる (無関係な固有名詞との誤検知防止)', () => {
    const bundle = buildBundle('ぶいちゃんという名前の猫を飼っています。')
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence が 0.5 超になる', () => {
    const bundle = {
      ...buildBundle(null),
      followGraphLabelSignals: {
        topic_vrchat: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...buildBundle(null),
      followGraphLabelSignals: {
        topic_vrchat: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })
  it('bio が無くフォローグラフのサンプルも不足している場合、evaluable: false・confidence: 0.5 になる', () => {
    const bundle = {
      ...buildBundle(null),
      followGraphLabelSignals: {
        topic_vrchat: {
          followeeLabeledCount: 1,
          followeeTotalCount: 3,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('bio があればフォローグラフのサンプルが不足していても evaluable: true になる', () => {
    const result = topicVrchatRule.evaluate(buildBundle('日常アカウントです'))
    expect(result.evaluable).toBe(true)
  })

  it('bio が null でもツイートで VRChat キーワードにマッチすれば evaluable: true・confidence: 0.8 になる', () => {
    const bundle = buildBundle(null, [{ fullText: '今日は友達と VRChat で遊びました！' }])
    const result = topicVrchatRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.evaluable).toBe(true)
    expect(result.confidence).toBe(0.8)
  })
})
