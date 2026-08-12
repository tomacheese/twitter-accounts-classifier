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

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence が 0.5 超になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_vtuber: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicVtuberRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_vtuber: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicVtuberRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })
  it('bio が無くフォローグラフのサンプルも不足している場合、evaluable: false・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_vtuber: {
          followeeLabeledCount: 1,
          followeeTotalCount: 3,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicVtuberRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('bio があればフォローグラフのサンプルが不足していても evaluable: true になる', () => {
    const result = topicVtuberRule.evaluate(makeBundle({ bio: '日常アカウントです' }))
    expect(result.evaluable).toBe(true)
  })
})
