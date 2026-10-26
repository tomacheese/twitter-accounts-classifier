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

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence が 0.5 超になる', () => {
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
    expect(result.confidence).toBeGreaterThan(0.5)
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
  it('bio が無くフォローグラフのサンプルも不足している場合、evaluable: false・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_illustration: {
          followeeLabeledCount: 1,
          followeeTotalCount: 3,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicIllustrationRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('is false for a bio crediting a different person as the illustrator ("イラスト提供：〇〇様")', () => {
    expect(
      topicIllustrationRule.evaluate(
        makeBundle({ bio: 'イラスト提供：ねこ様。日常アカウントです' }),
      ).value,
    ).toBe(false)
  })

  it('bio があればフォローグラフのサンプルが不足していても evaluable: true になる', () => {
    const result = topicIllustrationRule.evaluate(makeBundle({ bio: '日常アカウントです' }))
    expect(result.evaluable).toBe(true)
  })

  it("is false for a bio that only says it retweets others' illustrations", () => {
    expect(
      topicIllustrationRule.evaluate(
        makeBundle({ bio: 'お出かけの記録を載せています。アニメのイラストもよくRTします' }),
      ).value,
    ).toBe(false)
  })

  it('stays true for a bio that declares drawing illustrations and welcomes retweets', () => {
    expect(
      topicIllustrationRule.evaluate(makeBundle({ bio: 'イラストを描いています。RT歓迎です' }))
        .value,
    ).toBe(true)
  })

  it.each(['SRPGが好きなおじさんです。推し絵師⇒【ねこ】', '好きな絵師：ねこ先生'])(
    'is false for a bio that only names another artist as a favorite (%s)',
    (bio) => {
      expect(topicIllustrationRule.evaluate(makeBundle({ bio })).value).toBe(false)
    },
  )

  it('stays true for a self-declared artist who also names a favorite artist', () => {
    expect(
      topicIllustrationRule.evaluate(makeBundle({ bio: '絵師です。推し絵師はねこ先生' })).value,
    ).toBe(true)
  })

  it('小説書きの bio で pixiv の記載だけなら false', () => {
    expect(
      topicIllustrationRule.evaluate(makeBundle({ bio: 'サークル主宰の小説書きです pixiv→リンク' }))
        .value,
    ).toBe(false)
  })

  it('小説書きでもイラスト系の語を併記していれば true', () => {
    expect(
      topicIllustrationRule.evaluate(makeBundle({ bio: '小説とイラストを描きます pixiv→リンク' }))
        .value,
    ).toBe(true)
  })

  it('小説の語がなければ pixiv の記載だけで true', () => {
    expect(
      topicIllustrationRule.evaluate(makeBundle({ bio: '趣味垢です pixiv→リンク' })).value,
    ).toBe(true)
  })

  it('ノベルティの語だけでは小説書きとみなさず pixiv の記載で true', () => {
    expect(
      topicIllustrationRule.evaluate(makeBundle({ bio: 'ノベルティ制作の担当です pixiv→リンク' }))
        .value,
    ).toBe(true)
  })
})
