import { describe, expect, it } from 'vitest'
import { topicParentingRule } from './topic-parenting'
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

describe('topicParentingRule', () => {
  it('is true for a bio mentioning 育児', () => {
    expect(
      topicParentingRule.evaluate(makeBundle({ bio: '0歳の育児中です。日々の記録' })).value,
    ).toBe(true)
  })

  it('is true for a bio mentioning 子育て', () => {
    expect(topicParentingRule.evaluate(makeBundle({ bio: '会社員・子育て世帯です' })).value).toBe(
      true,
    )
  })

  it('is true for a bio mentioning ワーママ', () => {
    expect(
      topicParentingRule.evaluate(makeBundle({ bio: 'フルタイム勤務のワーママです🐈' })).value,
    ).toBe(true)
  })

  it('is true for an English parenting bio', () => {
    expect(
      topicParentingRule.evaluate(makeBundle({ bio: 'Sharing my parenting journey daily' })).value,
    ).toBe(true)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicParentingRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })
})
