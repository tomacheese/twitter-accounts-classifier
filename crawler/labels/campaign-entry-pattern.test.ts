import { describe, expect, it } from 'vitest'
import { isCampaignEntryText, isHashtagOnlyText } from './campaign-entry-pattern'

describe('isHashtagOnlyText', () => {
  it.each(['#sampletag', '#sampletag #othertag', '＃サンプル　#sample', '#a#b'])(
    'is true for hashtag-only text (%s)',
    (text) => {
      expect(isHashtagOnlyText(text)).toBe(true)
    },
  )

  it.each(['', '#', 'text #sampletag', '#sampletag text', '#a #b x'])(
    'is false when the text has anything besides hashtags (%s)',
    (text) => {
      expect(isHashtagOnlyText(text)).toBe(false)
    },
  )

  it('returns quickly for many consecutive hashtag markers followed by a non-hashtag word', () => {
    const text = `${'#a'.repeat(200)} x`
    const start = Date.now()
    expect(isHashtagOnlyText(text)).toBe(false)
    expect(Date.now() - start).toBeLessThan(200)
  })
})

describe('isCampaignEntryText', () => {
  it('treats hashtag-only text as a campaign entry', () => {
    expect(isCampaignEntryText('#sampletag')).toBe(true)
  })

  it('keeps plain promotional text out of campaign entries', () => {
    expect(isCampaignEntryText('稼げる方法を教えます')).toBe(false)
  })
})
