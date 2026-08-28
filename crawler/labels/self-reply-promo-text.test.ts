import { describe, expect, it } from 'vitest'
import { normalizeSelfReplyPromoText } from './self-reply-promo-text'

describe('normalizeSelfReplyPromoText', () => {
  it('removes URLs, mentions, and collapses whitespace', () => {
    const result = normalizeSelfReplyPromoText(
      '@alice   これマジで凄いから見て https://t.co/abc123   ',
    )
    expect(result).toBe('これマジで凄いから見て')
  })

  it('lowercases the result', () => {
    expect(normalizeSelfReplyPromoText('Check This Out')).toBe('check this out')
  })

  it('does not drop short text (unlike normalizeReplyText)', () => {
    // duplicate-reply-index.ts の normalizeReplyText は 20 文字未満を空文字列にするが、
    // 誘導文は短いことが多いため、この関数では文字数による足切りをしない。
    expect(normalizeSelfReplyPromoText('やばいこれ↓')).toBe('やばいこれ↓')
  })

  it('collapses repeated arrow symbols to a single arrow', () => {
    expect(normalizeSelfReplyPromoText('見て↓↓↓')).toBe(normalizeSelfReplyPromoText('見て↓'))
  })

  it('collapses repeated exclamation marks to a single mark', () => {
    expect(normalizeSelfReplyPromoText('凄い！！！')).toBe(normalizeSelfReplyPromoText('凄い！'))
  })

  it('returns an empty string for a URL-only reply', () => {
    expect(normalizeSelfReplyPromoText('https://t.co/onlylink')).toBe('')
  })
})
