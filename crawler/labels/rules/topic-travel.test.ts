import { describe, expect, it } from 'vitest'
import { topicTravelRule } from './topic-travel'
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

describe('topicTravelRule', () => {
  it('is true for a Japanese travel bio', () => {
    expect(
      topicTravelRule.evaluate(makeBundle({ bio: '日常の記録｜国内・海外旅行✈️' })).value,
    ).toBe(true)
  })

  it('is true for a bio listing 一人旅', () => {
    expect(topicTravelRule.evaluate(makeBundle({ bio: '一人旅と温泉巡りが趣味です' })).value).toBe(
      true,
    )
  })

  it('is true for an English travel bio', () => {
    expect(topicTravelRule.evaluate(makeBundle({ bio: 'Books. Coffee. Travel.' })).value).toBe(true)
  })

  it('is true for a bio using the noun "traveler"', () => {
    expect(topicTravelRule.evaluate(makeBundle({ bio: 'Photographer | Traveler' })).value).toBe(
      true,
    )
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicTravelRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('is false for a bio using 旅 only inside 旅館 (inn), not declaring travel as an interest', () => {
    expect(topicTravelRule.evaluate(makeBundle({ bio: '旅館で働いています' })).value).toBe(false)
  })

  it('is false when the bio is null', () => {
    expect(topicTravelRule.evaluate(makeBundle({ bio: null })).value).toBe(false)
  })

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_travel: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicTravelRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_travel: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicTravelRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })
})
