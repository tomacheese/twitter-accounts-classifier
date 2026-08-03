import { describe, expect, it } from 'vitest'
import { topicIllustrationRule } from './topic-illustration'
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

describe('topicIllustrationRule', () => {
  it('is true for a bio declaring illustration activity', () => {
    expect(
      topicIllustrationRule.evaluate(makeBundle({ bio: 'イラスト投稿メインの絵描きです' })).value,
    ).toBe(true)
  })

  it('is true for a bio linking to pixiv', () => {
    expect(
      topicIllustrationRule.evaluate(makeBundle({ bio: 'pixiv https://t.co/exampleXXXX' })).value,
    ).toBe(true)
  })

  it('is true for an English illustrator bio', () => {
    expect(
      topicIllustrationRule.evaluate(
        makeBundle({ bio: 'Freelance illustrator, open for commissions' }),
      ).value,
    ).toBe(true)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicIllustrationRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_illustration: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicIllustrationRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_illustration: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicIllustrationRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })
})
