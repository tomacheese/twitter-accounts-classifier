import { describe, expect, it } from 'vitest'
import { topicFinanceRule } from './topic-finance'
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

describe('topicFinanceRule', () => {
  it('is true for a brokerage/trading bio', () => {
    expect(
      topicFinanceRule.evaluate(
        makeBundle({ bio: 'Online broker offering trading in stocks and futures' }),
      ).value,
    ).toBe(true)
  })

  it('is true for a Japanese stock/investment bio', () => {
    expect(
      topicFinanceRule.evaluate(makeBundle({ bio: '株式投資と資産運用について発信しています' }))
        .value,
    ).toBe(true)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicFinanceRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('is false for a bio containing "investigative" (not a word-boundary match for "invest")', () => {
    expect(
      topicFinanceRule.evaluate(makeBundle({ bio: 'Investigative journalist covering local news' }))
        .value,
    ).toBe(false)
  })

  it('is false for a bio containing "株式会社" (the generic Japanese corporate suffix, not a finance signal)', () => {
    expect(
      topicFinanceRule.evaluate(
        makeBundle({ bio: '株式会社サンプル包材は、紙袋を中心とした包装資材メーカーです。' }),
      ).value,
    ).toBe(false)
  })

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_finance: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicFinanceRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_finance: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicFinanceRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })
})
