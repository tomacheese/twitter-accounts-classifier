import { describe, expect, it } from 'vitest'
import { topicMovieRule } from './topic-movie'
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

describe('topicMovieRule', () => {
  it('is true for a bio declaring a love of movies', () => {
    expect(
      topicMovieRule.evaluate(makeBundle({ bio: '映画好きの会社員です。年間100本鑑賞します' }))
        .value,
    ).toBe(true)
  })

  it('is true for a bio mentioning drama-watching', () => {
    expect(
      topicMovieRule.evaluate(
        makeBundle({ bio: '韓国ドラマにハマっています。おすすめ教えてください' }),
      ).value,
    ).toBe(true)
  })

  it('is true for an English cinephile bio', () => {
    expect(
      topicMovieRule.evaluate(makeBundle({ bio: 'Cinephile | Reviewing one film a week' })).value,
    ).toBe(true)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicMovieRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('is false for a bio containing "film" only as a substring of an unrelated word', () => {
    expect(
      topicMovieRule.evaluate(makeBundle({ bio: 'Currently filming a documentary project' })).value,
    ).toBe(false)
  })

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence が 0.5 超になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_movie: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicMovieRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_movie: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicMovieRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })
  it('bio が無くフォローグラフのサンプルも不足している場合、evaluable: false・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_movie: {
          followeeLabeledCount: 1,
          followeeTotalCount: 3,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicMovieRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('bio があればフォローグラフのサンプルが不足していても evaluable: true になる', () => {
    const result = topicMovieRule.evaluate(makeBundle({ bio: '日常アカウントです' }))
    expect(result.evaluable).toBe(true)
  })
})
