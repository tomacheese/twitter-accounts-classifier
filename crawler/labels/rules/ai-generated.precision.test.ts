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
  ])('does not treat generative-AI usage restrictions or permissions as self-declaration: %s', (bio) => {
    expect(aiGeneratedRule.evaluate(makeBundle(bio)).value).toBe(false)
  })

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
  ])('preserves creator self-declarations that are not permission/ban grammar: %s', (bio) => {
    expect(aiGeneratedRule.evaluate(makeBundle(bio)).value).toBe(true)
  })
})
