import { describe, expect, it } from 'vitest'
import { topicBeautyRule } from './topic-beauty'
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

describe('topicBeautyRule', () => {
  it('is true for a Japanese cosmetics bio', () => {
    expect(
      topicBeautyRule.evaluate(makeBundle({ bio: 'コスメ集めとメイク研究が趣味です' })).value,
    ).toBe(true)
  })

  it('is true for a bio mentioning 美容 and スキンケア', () => {
    expect(
      topicBeautyRule.evaluate(makeBundle({ bio: '美容師です。スキンケアの豆知識を発信' })).value,
    ).toBe(true)
  })

  it('is true for an English skincare/makeup bio', () => {
    expect(
      topicBeautyRule.evaluate(makeBundle({ bio: 'Daily dose of skincare and makeup tips' })).value,
    ).toBe(true)
  })

  it('is true for a bio mentioning ヘアメイク', () => {
    expect(
      topicBeautyRule.evaluate(makeBundle({ bio: 'ヘアメイクの仕事をしています' })).value,
    ).toBe(true)
  })

  it('is false for a bio using リメイク (remake) as a substring of メイク', () => {
    expect(
      topicBeautyRule.evaluate(makeBundle({ bio: '古い家具のリメイクが好きです' })).value,
    ).toBe(false)
  })

  it('is false for a bio using bare "beauty" in an unrelated idiom', () => {
    expect(
      topicBeautyRule.evaluate(makeBundle({ bio: 'We are chasing the beauty of the open road.' }))
        .value,
    ).toBe(false)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicBeautyRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('is false when the bio is null', () => {
    expect(topicBeautyRule.evaluate(makeBundle({ bio: null })).value).toBe(false)
  })

  it('bioにキーワードがなく、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_beauty: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }

    const result = topicBeautyRule.evaluate(bundle)

    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_beauty: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }

    expect(topicBeautyRule.evaluate(bundle).value).toBe(false)
  })
})
