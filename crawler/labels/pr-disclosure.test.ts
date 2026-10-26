import { describe, expect, it } from 'vitest'
import { hasPrDisclosure } from './pr-disclosure'

const entry = (n: number) => `応募${'あ'.repeat(n - 2)} #PR`

describe('hasPrDisclosure', () => {
  it('is true for the #PR hashtag', () => {
    expect(hasPrDisclosure('新商品を使ってみました！ #PR @brand')).toBe(true)
  })

  it('is true for the Japanese bracket form', () => {
    expect(hasPrDisclosure('このTシャツのデザインめちゃくちゃ好きなんだよな【PR】')).toBe(true)
  })

  it('does not match "#PR" as a substring of a longer hashtag', () => {
    expect(hasPrDisclosure('応援よろしく #PRIDE2026')).toBe(false)
  })

  it('does not treat an English "(PR)" without Japanese text as a sponsorship disclosure', () => {
    expect(
      hasPrDisclosure('Finally merged the caching fix (PR) after three rounds of review.'),
    ).toBe(false)
  })

  it('is false when there is no PR marker at all', () => {
    expect(hasPrDisclosure('今日はいい天気ですね')).toBe(false)
  })

  it('is false for a giveaway-entry post even though it carries #PR', () => {
    expect(hasPrDisclosure('このキャンペーンに応募しました!当選しますように #PR')).toBe(false)
  })

  it('is true for a gifted-product review whose campaign name happens to contain "キャンペーン"', () => {
    expect(hasPrDisclosure('〇〇キャンペーンでいただいたコスメを紹介します #PR')).toBe(true)
  })

  it('is false for a short sweepstakes-entry quote tweet carrying a mandated #PR', () => {
    expect(
      hasPrDisclosure('応募します！ #サンプル飲料キャンペーン #PR https://t.co/exampleXXXX', {
        isQuote: true,
      }),
    ).toBe(false)
  })

  it('is true for the same short text when it is not a quote tweet', () => {
    expect(hasPrDisclosure('応募します！ #サンプル飲料キャンペーン #PR')).toBe(true)
  })

  it('is true for a quote tweet with a long body or without sweepstakes words', () => {
    expect(
      hasPrDisclosure(
        'サンプル飲料を一週間飲み続けてみた感想をまとめました。香りが良く、毎朝の習慣になりそうです。応募は終わりましたが紹介したくて #PR',
        { isQuote: true },
      ),
    ).toBe(true)
    expect(hasPrDisclosure('これ便利でした！ #PR', { isQuote: true })).toBe(true)
  })

  it('does not treat RT inside an English word as a sweepstakes word', () => {
    expect(hasPrDisclosure('new sport shoes #PR', { isQuote: true })).toBe(true)
    expect(hasPrDisclosure('RT to enter #PR', { isQuote: true })).toBe(false)
  })

  it('treats a body of exactly 40 characters as short and 41 as not short', () => {
    expect(hasPrDisclosure(entry(40), { isQuote: true })).toBe(false)
    expect(hasPrDisclosure(entry(41), { isQuote: true })).toBe(true)
  })
})
