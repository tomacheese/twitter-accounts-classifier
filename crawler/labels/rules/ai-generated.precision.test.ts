import { describe, expect, it } from 'vitest'
import type { AccountFeatureBundle } from '../types'
import { aiGeneratedRule } from './ai-generated'

function makeBundle(bio: string): AccountFeatureBundle {
  return {
    account: {
      id: 'fictional-ai-1',
      screenName: 'fictional_ai',
      displayName: 'Fictional AI',
      bio,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      isBlueVerified: false,
      verifiedType: null,
    },
    recentTweets: [],
  }
}

describe('aiGeneratedRule precision regressions', () => {
  it.each([
    '自作イラストの生成AIへの利用はご遠慮ください。',
    'イラスト投稿垢です。AI生成等への画像利用はお断りしています。',
    '手描き専門。生成AIの利用に反対の立場です。',
    '自作絵を載せています。生成AIへの使用は可、よろしくお願いします。',
    '画像は手描きです。生成AIへの利用は可',
  ])(
    'does not treat generative-AI usage restrictions or permissions as self-declaration: %s',
    (bio) => {
      expect(aiGeneratedRule.evaluate(makeBundle(bio)).value).toBe(false)
    },
  )

  it('preserves an independent AI-image posting declaration beside a usage restriction', () => {
    expect(
      aiGeneratedRule.evaluate(
        makeBundle(
          '自作イラストの生成AIへの利用はご遠慮ください。最近はAI画像を生成して投稿しています。',
        ),
      ).value,
    ).toBe(true)
  })

  it.each([
    '生成AI×動画制作をしています。',
    '生成AIの利用で画像を作っています。',
    '生成AIの利用で画像を作っています。可愛い猫の作品を投稿しています。',
  ])('preserves creator self-declarations that are not permission/ban grammar: %s', (bio) => {
    expect(aiGeneratedRule.evaluate(makeBundle(bio)).value).toBe(true)
  })
})

describe('aiGeneratedRule usage-condition notices (negation window)', () => {
  it.each([
    '生成AIでイラストを作っています。二次利用禁止',
    'AI生成イラストを投稿しています。無断学習禁止です',
    'AI生成の作品を投稿しています ⚠️無断転載・二次利用・学習禁止⚠️',
    'AI-generated images. No reposts. 無断学習NG',
    'AI生成イラストを投稿しています。二次創作NG、商用利用は要相談',
  ])('does not negate a self-declaration beside usage conditions: %s', (bio) => {
    expect(aiGeneratedRule.evaluate(makeBundle(bio)).value).toBe(true)
  })

  it('keeps the same result when the bio is shortened around the usage condition', () => {
    expect(aiGeneratedRule.evaluate(makeBundle('AI生成画像を投稿。二次利用禁止')).value).toBe(true)
  })

  it('does not let a prohibition in another sentence negate the declaration', () => {
    expect(aiGeneratedRule.evaluate(makeBundle('AI生成画像を投稿。AI生成禁止')).value).toBe(true)
  })

  it('negates a prohibition that sits in the same sentence as the declaration', () => {
    expect(aiGeneratedRule.evaluate(makeBundle('AI生成禁止。画像を投稿')).value).toBe(false)
    expect(aiGeneratedRule.evaluate(makeBundle('画像を投稿。AI生成禁止')).value).toBe(false)
  })

  it.each(['AI生成禁止', '生成AI使用禁止です', '❌生成AI', '手描き専門。AI生成NGです。'])(
    'still negates a prohibition that directly governs the AI term: %s',
    (bio) => {
      expect(aiGeneratedRule.evaluate(makeBundle(bio)).value).toBe(false)
    },
  )
})

describe('aiGeneratedRule hobby and work mentions', () => {
  it.each([
    '趣味で生成AIを遊んでいます',
    '音楽生成AIで曲を作って遊んでいます',
    'ノート作成業務で生成AIを活用しています',
    'フリーランスDTP\nカメラ\n生成AI\nよろしくお願いします',
    'イラスト\n生成AI\nゲーム実況',
    '写真、\n生成AI\nカフェ巡り',
  ])('is false for a hobby, work or newline-separated mention: %s', (bio) => {
    expect(aiGeneratedRule.evaluate(makeBundle(bio)).value).toBe(false)
  })

  it('keeps an icon-only AI-generated declaration as a self-declaration', () => {
    expect(aiGeneratedRule.evaluate(makeBundle('アイコンはAI生成です')).value).toBe(true)
  })

  it('does not change for an opinion link bio', () => {
    expect(
      aiGeneratedRule.evaluate(
        makeBundle('生成AIについての見解はこちら https://example.com/opinion'),
      ).value,
    ).toBe(false)
  })
})
