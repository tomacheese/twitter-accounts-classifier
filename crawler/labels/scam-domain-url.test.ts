import { describe, expect, it } from 'vitest'
import { classifyScamDomainUrl } from './scam-domain-url'

describe('classifyScamDomainUrl', () => {
  it('detects an exact hostname match against an indicator domain', () => {
    const evidence = classifyScamDomainUrl('https://1link.jp/fictional')
    expect(evidence?.host).toBe('1link.jp')
    expect(evidence?.indicator.domain).toBe('1link.jp')
  })

  it('detects a subdomain of an indicator domain', () => {
    const evidence = classifyScamDomainUrl('https://foo.1link.jp/fictional')
    expect(evidence?.host).toBe('foo.1link.jp')
    expect(evidence?.indicator.domain).toBe('1link.jp')
  })

  it('does not classify a lookalike domain', () => {
    expect(classifyScamDomainUrl('https://evil1link.jp/fictional')).toBeNull()
  })

  it('does not classify a domain not on the indicator list', () => {
    expect(classifyScamDomainUrl('https://example.com/fictional')).toBeNull()
  })

  it('does not classify malformed input', () => {
    expect(classifyScamDomainUrl('not a url')).toBeNull()
  })

  it('does not classify a non-http(s) protocol', () => {
    expect(classifyScamDomainUrl('ftp://1link.jp/fictional')).toBeNull()
  })
})
