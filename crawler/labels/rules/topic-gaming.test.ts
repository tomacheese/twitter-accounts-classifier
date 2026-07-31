import { describe, expect, it } from 'vitest'
import { topicGamingRule } from './topic-gaming'
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

describe('topicGamingRule', () => {
  it('is true for a gaming bio', () => {
    expect(
      topicGamingRule.evaluate(makeBundle({ bio: 'ソシャゲ大好き、ゲーム実況もやってます' })).value,
    ).toBe(true)
  })

  it('is true for an English gaming bio', () => {
    expect(topicGamingRule.evaluate(makeBundle({ bio: 'Casual gamer | esports fan' })).value).toBe(
      true,
    )
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicGamingRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' }))
        .value,
    ).toBe(false)
  })
})
