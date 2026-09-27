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

  it('does not classify combat-sports spectators using follow-graph evidence alone', () => {
    const bundle = {
      ...makeBundle({ bio: '格闘技観戦が趣味です' }),
      followGraphLabelSignals: {
        topic_fitness: {
          followeeLabeledCount: 10,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    expect(topicFitnessRule.evaluate(bundle).value).toBe(false)
  })

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence が 0.5 超になる', () => {
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
    expect(result.confidence).toBeGreaterThan(0.5)
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
  it('bio が無くフォローグラフのサンプルも不足している場合、evaluable: false・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_fitness: {
          followeeLabeledCount: 1,
          followeeTotalCount: 3,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicFitnessRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('bio があればフォローグラフのサンプルが不足していても evaluable: true になる', () => {
    const result = topicFitnessRule.evaluate(makeBundle({ bio: '日常アカウントです' }))
    expect(result.evaluable).toBe(true)
  })

  it.each([
    '走るのは好きですが筋トレは全くしません',
    'ジムには通っていません。筋トレはしない派です',
    'I never do any workout',
  ])('is false for a bio explicitly denying that the owner trains: %s', (bio) => {
    expect(topicFitnessRule.evaluate(makeBundle({ bio })).value).toBe(false)
  })

  it('keeps a bio positive when an unrelated denial appears far from the fitness keyword', () => {
    expect(
      topicFitnessRule.evaluate(
        makeBundle({ bio: '毎日筋トレしています。お酒は飲みません。休日は読書' }),
      ).value,
    ).toBe(true)
  })

  it.each([
    '筋トレしながら勉強しています',
    '筋トレしなきゃダメだけど逃げがち',
    '筋トレもしないと',
    '筋トレはやらないよりはマシな程度',
    'I never skip a workout',
    "I don't miss a workout",
  ])(
    'keeps a bio positive when a nearby negation word does not deny the practice itself: %s',
    (bio) => {
      expect(topicFitnessRule.evaluate(makeBundle({ bio })).value).toBe(true)
    },
  )
})
