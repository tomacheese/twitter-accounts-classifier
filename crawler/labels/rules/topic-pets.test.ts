import { describe, expect, it } from 'vitest'
import { topicPetsRule } from './topic-pets'
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

describe('topicPetsRule', () => {
  it('is true for a bio mentioning 愛猫', () => {
    expect(topicPetsRule.evaluate(makeBundle({ bio: '愛猫との日常を投稿しています' })).value).toBe(
      true,
    )
  })

  it('is true for a bio mentioning 保護犬', () => {
    expect(
      topicPetsRule.evaluate(makeBundle({ bio: '保護犬を1匹迎えました。成長記録を発信中' })).value,
    ).toBe(true)
  })

  it('is true for a bio mentioning わんこ・にゃんこ', () => {
    expect(
      topicPetsRule.evaluate(makeBundle({ bio: 'わんこ2匹とにゃんこ1匹の多頭飼いです' })).value,
    ).toBe(true)
  })

  it('is true for an English "pet lover" bio', () => {
    expect(topicPetsRule.evaluate(makeBundle({ bio: 'Dog mom, cat dad, pet lover' })).value).toBe(
      true,
    )
  })

  it('is false for a bio using 猫背 (hunched back), an idiom unrelated to pets', () => {
    expect(
      topicPetsRule.evaluate(makeBundle({ bio: '在宅ワークで猫背が悪化しました' })).value,
    ).toBe(false)
  })

  it('is false for a bio using 負け犬, an idiom unrelated to pets', () => {
    expect(
      topicPetsRule.evaluate(makeBundle({ bio: '負け犬でも毎日楽しく生きています' })).value,
    ).toBe(false)
  })

  it('is false for a bio mentioning にゃんこ大戦争 as a hobby game', () => {
    expect(
      topicPetsRule.evaluate(
        makeBundle({ bio: 'にゃんこ大戦争にハマってます。日課で攻略配信も見てます' }),
      ).value,
    ).toBe(false)
  })

  it('is false for a bio using にゃんこ only in the same game character/community context', () => {
    expect(
      topicPetsRule.evaluate(
        makeBundle({ bio: 'にゃんこ好きなキャラで初心者攻略まとめを作ってます' }),
      ).value,
    ).toBe(false)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicPetsRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('is false when the bio is null', () => {
    expect(topicPetsRule.evaluate(makeBundle({ bio: null })).value).toBe(false)
  })

  it('bioにキーワードがなく、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence が 0.5 超になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_pets: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }

    const result = topicPetsRule.evaluate(bundle)

    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_pets: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }

    expect(topicPetsRule.evaluate(bundle).value).toBe(false)
  })
  it('bio が無くフォローグラフのサンプルも不足している場合、evaluable: false・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_pets: {
          followeeLabeledCount: 1,
          followeeTotalCount: 3,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicPetsRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('bio があればフォローグラフのサンプルが不足していても evaluable: true になる', () => {
    const result = topicPetsRule.evaluate(makeBundle({ bio: '日常アカウントです' }))
    expect(result.evaluable).toBe(true)
  })
})
