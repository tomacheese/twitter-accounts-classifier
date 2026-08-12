import { describe, expect, it } from 'vitest'
import { topicAnimeRule } from './topic-anime'
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

describe('topicAnimeRule', () => {
  it('is true for an anime/manga bio', () => {
    expect(
      topicAnimeRule.evaluate(makeBundle({ bio: 'アニメと漫画が好きな社会人です' })).value,
    ).toBe(true)
  })

  it('is true for an English anime bio', () => {
    expect(topicAnimeRule.evaluate(makeBundle({ bio: 'Anime and manga fan account' })).value).toBe(
      true,
    )
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicAnimeRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence が 0.5 超になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_anime: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicAnimeRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_anime: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicAnimeRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })

  it('bio が無くフォローグラフのサンプルも不足している場合、evaluable: false・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_anime: {
          followeeLabeledCount: 1,
          followeeTotalCount: 3,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicAnimeRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('bio があればフォローグラフのサンプルが不足していても evaluable: true になる', () => {
    const result = topicAnimeRule.evaluate(makeBundle({ bio: '日常アカウントです' }))
    expect(result.evaluable).toBe(true)
  })
})
