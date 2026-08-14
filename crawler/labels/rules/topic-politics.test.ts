import { describe, expect, it } from 'vitest'
import { topicPoliticsRule } from './topic-politics'
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

describe('topicPoliticsRule', () => {
  it('is true for a bio naming a political party', () => {
    expect(
      topicPoliticsRule.evaluate(makeBundle({ bio: '自民党所属、市議会議員をしています' })).value,
    ).toBe(true)
  })

  it('is true for an English politician bio', () => {
    expect(topicPoliticsRule.evaluate(makeBundle({ bio: 'State senator, district 4' })).value).toBe(
      true,
    )
  })

  it('is false for a bio using "保守" in the maintenance sense, not political conservatism', () => {
    expect(
      topicPoliticsRule.evaluate(makeBundle({ bio: 'ビル設備の保守エンジニアです' })).value,
    ).toBe(false)
  })

  it('is false for an unrelated bio, with high confidence since no keyword evidence was found', () => {
    const result = topicPoliticsRule.evaluate(
      makeBundle({ bio: '毎日ラーメンの写真を載せています' }),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(1)
  })

  it.each([
    '政治家を応援しています',
    '自民党を応援しています',
    '地元の市議会議員を支持します',
    'Supporting senator Jane Doe',
  ])("does not treat a supporter bio as the account holder's political office: %s", (bio) => {
    expect(topicPoliticsRule.evaluate(makeBundle({ bio })).value).toBe(false)
  })

  it.each(['自民党所属、市議会議員をしています', 'State senator, district 4'])(
    'keeps explicit self-identification positive: %s',
    (bio) => {
      expect(topicPoliticsRule.evaluate(makeBundle({ bio })).value).toBe(true)
    },
  )
})
