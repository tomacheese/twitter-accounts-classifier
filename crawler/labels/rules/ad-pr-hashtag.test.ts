import { describe, expect, it } from 'vitest'
import { adPrHashtagRule } from './ad-pr-hashtag'
import type { AccountFeatureBundle } from '../types'

function makeBundle(recentTweets: AccountFeatureBundle['recentTweets']): AccountFeatureBundle {
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
    },
    recentTweets,
  }
}

function tweet(
  overrides: Partial<AccountFeatureBundle['recentTweets'][number]>,
): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: 't1',
    fullText: 'hello',
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply: false,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
    ...overrides,
  }
}

describe('adPrHashtagRule', () => {
  it('is true when a recent tweet carries the #PR hashtag', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: '新商品を使ってみました！ #PR @brand' })]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('is true when a recent tweet is flagged isPaidPromotion, even without #PR in the text, given enough sample', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([
        tweet({ fullText: '新商品を使ってみました！', isPaidPromotion: true }),
        tweet({ fullText: '今日はいい天気ですね' }),
        tweet({ fullText: 'お昼ご飯なに食べようかな' }),
      ]),
    )
    expect(result.value).toBe(true)
  })

  it('is false when the only #PR-tagged tweet is a giveaway/campaign-entry post', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([
        tweet({ fullText: 'どうか当たりますように🙏 #サンプル飲料で当たって嬉しい #PR' }),
        tweet({ fullText: '今日はいい天気ですね' }),
        tweet({ fullText: 'お昼ご飯なに食べようかな' }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('is false when neither signal is present', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: '今日はいい天気ですね' })]),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it('does not match "#PR" as a substring of a longer hashtag', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: '応援よろしく #PRIDE2026' })]),
    )
    expect(result.value).toBe(false)
  })

  it.each([
    ['flush against preceding punctuation', '今夜はゲーム配信やります！！#PR'],
    ['preceded by a zero-width space', 'サンプル食器 4点セット ¥1,000 19:08 ​#PR #ショップ'],
    ['the Japanese bracket form', 'このTシャツのデザインめちゃくちゃ好きなんだよな【PR】'],
    ['the parenthesised form', 'この扇風機の起動音が可愛すぎる笑(pr)'],
    ['the full-width parenthesised form', 'のんびりした夏休みを過ごしてる🌻（pr）'],
    ['the square-bracket form', '敏感肌の味方✧サンプル化粧水が新登場！[PR]'],
  ])('is true when a recent tweet discloses via %s', (_label, fullText) => {
    expect(adPrHashtagRule.evaluate(makeBundle([tweet({ fullText })])).value).toBe(true)
  })

  it.each([
    ['a hashtag continuing in lowercase', '🌟おはよう🌟 #PRiSMサンプル #テスト'],
    [
      'a hashtag continuing with an underscore',
      'もし当選したら嬉しい… #GIVEAWAY #PRESENT_CAMPAIGN_2026',
    ],
  ])('still does not match "#PR" inside %s', (_label, fullText) => {
    expect(adPrHashtagRule.evaluate(makeBundle([tweet({ fullText })])).value).toBe(false)
  })

  it('does not treat an English "(PR)" as a Japanese sponsorship disclosure', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([
        tweet({ fullText: 'Finally merged the caching fix (PR) after three rounds of review.' }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('does not match "#PR" inside a URL fragment', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: '詳しくはこちら https://example.com/docs/page#PR' })]),
    )
    expect(result.value).toBe(false)
  })

  it("is false when the only #PR-tagged tweet is a retweet of someone else's post", () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([
        tweet({
          fullText: 'RT @brand: 新商品を使ってみました！ #PR',
          isRetweet: true,
          isPaidPromotion: true,
        }),
      ]),
    )
    expect(result.value).toBe(false)
  })
})

describe('adPrHashtagRule campaign exclusion narrowing', () => {
  it('is true for a gifted-product review whose campaign name happens to contain "キャンペーン"', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: '〇〇キャンペーンでいただいたコスメを紹介します #PR' })]),
    )
    expect(result.value).toBe(true)
  })

  it('remains false for a giveaway-entry post', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: 'このキャンペーンに応募しました!当選しますように #PR' })]),
    )
    expect(result.value).toBe(false)
  })

  it('is false for the 応募してた (te-form) campaign-entry variant', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: 'このキャンペーンに応募してた #PR' })]),
    )
    expect(result.value).toBe(false)
  })

  it('is false for 当たりました without the ように suffix', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: '当たりました!ありがとうございます #PR' })]),
    )
    expect(result.value).toBe(false)
  })

  it('is false for the 抽選で…当選 campaign-entry variant', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: '抽選で当選しました #PR' })]),
    )
    expect(result.value).toBe(false)
  })

  it('matches 抽選で…当選 within the 10-character gap', () => {
    const filler = 'あ'.repeat(10)
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: `抽選で${filler}当選しました #PR` })]),
    )
    expect(result.value).toBe(false)
  })

  it('does not match 抽選で…当選 beyond the 10-character gap', () => {
    const filler = 'あ'.repeat(11)
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: `抽選で${filler}当選しました #PR` })]),
    )
    expect(result.value).toBe(true)
  })

  it('does not exclude a #PR post that merely mentions 懸賞 without an entry phrase', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: '本日の懸賞コーナーはこちら #PR' })]),
    )
    expect(result.value).toBe(true)
  })

  it('does not exclude a #PR post that merely mentions プレゼント企画 without an entry phrase', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: 'プレゼント企画開催中です #PR' })]),
    )
    expect(result.value).toBe(true)
  })

  it('does not exclude a #PR post that mentions bare 抽選 without a win phrase', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: '本日抽選を行いました #PR' })]),
    )
    expect(result.value).toBe(true)
  })

  it('does not exclude a #PR post that mentions bare 当選 without an entry phrase', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: '当選者発表!ご応募ありがとうございました #PR' })]),
    )
    expect(result.value).toBe(true)
  })
})

describe('adPrHashtagRule isPaidPromotion sample threshold removal', () => {
  it('is true even when only one sampled tweet has isPaidPromotion=true', () => {
    const result = adPrHashtagRule.evaluate(
      makeBundle([tweet({ fullText: 'こんにちは', isPaidPromotion: true })]),
    )
    expect(result.value).toBe(true)
  })
})
