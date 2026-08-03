import { describe, expect, it } from 'vitest'
import { topicVtuberRule } from './topic-vtuber'
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

describe('topicVtuberRule', () => {
  it('is true for a bio declaring VTuber activity', () => {
    expect(
      topicVtuberRule.evaluate(makeBundle({ bio: '個人勢Vtuberです。よろしくお願いします' })).value,
    ).toBe(true)
  })

  it('is true for a bio mentioning にじさんじ (a major VTuber agency)', () => {
    expect(topicVtuberRule.evaluate(makeBundle({ bio: 'にじさんじのライバーです' })).value).toBe(
      true,
    )
  })

  it('is true for a bio mentioning ホロライブ (a major VTuber agency)', () => {
    expect(
      topicVtuberRule.evaluate(makeBundle({ bio: 'ホロライブのファンです。推し活頑張ってます' }))
        .value,
    ).toBe(true)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicVtuberRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })
})
