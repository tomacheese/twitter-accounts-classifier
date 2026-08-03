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

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_food: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicFoodRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_food: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicFoodRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })
})
