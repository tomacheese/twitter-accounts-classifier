import { describe, expect, it } from 'vitest'
import { classifyAmazonAffiliateUrl } from './amazon-affiliate-url'

describe('classifyAmazonAffiliateUrl', () => {
  it('detects a non-empty Associates tag on an Amazon retail URL', () => {
    expect(
      classifyAmazonAffiliateUrl('https://www.amazon.co.jp/dp/FICTIONAL?tag=fictional-22'),
    ).toEqual({ kind: 'associate-tag', host: 'www.amazon.co.jp', tag: 'fictional-22' })
  })

  it('detects an amzn.to Associates short link', () => {
    expect(classifyAmazonAffiliateUrl('https://amzn.to/fictional')).toEqual({
      kind: 'associates-short-link',
      host: 'amzn.to',
    })
  })

  it('does not classify a plain Amazon product URL without an Associates tag', () => {
    expect(classifyAmazonAffiliateUrl('https://www.amazon.co.jp/dp/FICTIONAL')).toBeNull()
  })

  it('does not classify an a.co share URL by itself', () => {
    expect(classifyAmazonAffiliateUrl('https://a.co/fictional')).toBeNull()
  })

  it('does not classify a lookalike host', () => {
    expect(
      classifyAmazonAffiliateUrl('https://amazon.co.jp.evil.example/dp/FICTIONAL?tag=fictional-22'),
    ).toBeNull()
  })

  it('does not classify an empty Associates tag', () => {
    expect(classifyAmazonAffiliateUrl('https://amazon.co.jp/dp/FICTIONAL?tag=')).toBeNull()
  })

  it('does not classify malformed input', () => {
    expect(classifyAmazonAffiliateUrl('not a url')).toBeNull()
  })
})
