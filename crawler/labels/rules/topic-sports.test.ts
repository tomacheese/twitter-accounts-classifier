import { describe, expect, it } from 'vitest'
import { topicSportsRule } from './topic-sports'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  accountOverrides: Partial<AccountFeatureBundle['account']>,
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
    recentTweets: [],
  }
}

describe('topicSportsRule', () => {
  it('is true for a Japanese sports bio', () => {
    expect(
      topicSportsRule.evaluate(
        makeBundle({ bio: '野球が好きでプロ野球やドラフトの情報をつぶやきます' }),
      ).value,
    ).toBe(true)
  })

  it('is true for an English sports bio', () => {
    expect(
      topicSportsRule.evaluate(makeBundle({ bio: 'NBA fan | basketball highlights daily' })).value,
    ).toBe(true)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicSportsRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('is false for an esports bio, not tagging eスポーツ as sports', () => {
    expect(
      topicSportsRule.evaluate(
        makeBundle({ bio: '格闘ゲームをメインに活動しているeスポーツプレイヤー' }),
      ).value,
    ).toBe(false)
  })

  it('is false for a full-width ｅスポーツ bio', () => {
    expect(
      topicSportsRule.evaluate(makeBundle({ bio: 'ｅスポーツスタジオの運営スタッフです' })).value,
    ).toBe(false)
  })

  it('is true for a bio mentioning both esports and a real sport', () => {
    expect(
      topicSportsRule.evaluate(makeBundle({ bio: 'eスポーツと野球観戦が好きです' })).value,
    ).toBe(true)
  })

  it('is true for a plain スポーツ bio', () => {
    expect(topicSportsRule.evaluate(makeBundle({ bio: 'スポーツ観戦が大好きです🎵' })).value).toBe(
      true,
    )
  })
})
