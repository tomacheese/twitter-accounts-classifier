import { describe, expect, it } from 'vitest'
import { topicFoodRule } from './topic-food'
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

describe('topicFoodRule', () => {
  it('is true for a bio mentioning グルメ', () => {
    expect(
      topicFoodRule.evaluate(makeBundle({ bio: 'フルタイム勤務のワーママ/街歩きとグルメ🐈🍺' }))
        .value,
    ).toBe(true)
  })

  it('is true for a bio mentioning 料理', () => {
    expect(
      topicFoodRule.evaluate(makeBundle({ bio: '好きなもの アニメ・ゲーム・洋服・料理' })).value,
    ).toBe(true)
  })

  it('is true for an English foodie bio', () => {
    expect(
      topicFoodRule.evaluate(
        makeBundle({ bio: 'Home cook and foodie exploring local restaurants' }),
      ).value,
    ).toBe(true)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicFoodRule.evaluate(makeBundle({ bio: '毎日の出来事をつぶやいています' })).value,
    ).toBe(false)
  })
})
