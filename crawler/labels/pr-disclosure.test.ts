import { describe, expect, it } from 'vitest'
import { hasPrDisclosure } from './pr-disclosure'

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
})
