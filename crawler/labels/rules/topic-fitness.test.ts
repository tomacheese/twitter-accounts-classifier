import { describe, expect, it } from 'vitest'
import { topicFitnessRule } from './topic-fitness'
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

describe('topicFitnessRule', () => {
  it('is true for a bio mentioning 筋トレ', () => {
    expect(
      topicFitnessRule.evaluate(makeBundle({ bio: '会社員/趣味は筋トレと読書📚💪' })).value,
    ).toBe(true)
  })

  it('is true for a bio mentioning ボディメイク', () => {
    expect(
      topicFitnessRule.evaluate(makeBundle({ bio: '30代からのボディメイク記録垢' })).value,
    ).toBe(true)
  })

  it('is true for a bio mentioning フィットネス', () => {
    expect(
      topicFitnessRule.evaluate(makeBundle({ bio: 'フィットネスインストラクターです' })).value,
    ).toBe(true)
  })

  it('is true for an English gym-rat bio', () => {
    expect(
      topicFitnessRule.evaluate(makeBundle({ bio: 'Gym rat. Powerlifting and protein shakes.' }))
        .value,
    ).toBe(true)
  })

  it('is false for an unrelated bio mentioning muscle soreness ("筋肉痛")', () => {
    expect(
      topicFitnessRule.evaluate(makeBundle({ bio: '久々に運動したら筋肉痛がひどい' })).value,
    ).toBe(false)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicFitnessRule.evaluate(makeBundle({ bio: '毎日の出来事をつぶやいています' })).value,
    ).toBe(false)
  })

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_fitness: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicFitnessRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_fitness: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicFitnessRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })
})
