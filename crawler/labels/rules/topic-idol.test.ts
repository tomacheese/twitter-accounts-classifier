import { describe, expect, it } from 'vitest'
import { topicIdolRule } from './topic-idol'
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

describe('topicIdolRule', () => {
  it('is true for a bio naming an idol group (ジャニーズ)', () => {
    expect(
      topicIdolRule.evaluate(makeBundle({ bio: 'ジャニーズ系のグループを応援しています' })).value,
    ).toBe(true)
  })

  it('is true for an idol/K-POP bio', () => {
    expect(topicIdolRule.evaluate(makeBundle({ bio: 'K-POP idol fan account' })).value).toBe(true)
  })

  it('is true for a bio naming 坂道 (Sakamichi idol groups)', () => {
    expect(topicIdolRule.evaluate(makeBundle({ bio: '坂道オタクです' })).value).toBe(true)
  })

  it('is false for a bio using "推し" for a non-idol fandom (anime character)', () => {
    expect(
      topicIdolRule.evaluate(makeBundle({ bio: 'サンプル戦記のヒロインに沼って推し続けています' }))
        .value,
    ).toBe(false)
  })

  it('is false for a bio using "推し" for a VTuber (covered by topic_vtuber instead)', () => {
    expect(topicIdolRule.evaluate(makeBundle({ bio: '架空ゆめかが宇宙一の推しです' })).value).toBe(
      false,
    )
  })

  it('is false for a bio that only mentions unrelated "担当" (job-title sense, not idol fandom)', () => {
    expect(topicIdolRule.evaluate(makeBundle({ bio: '経理担当として働いています' })).value).toBe(
      false,
    )
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicIdolRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })
})
