import { describe, expect, it } from 'vitest'
import { classifyXStatusUrl } from './x-status-url'

describe('classifyXStatusUrl', () => {
  it('classifies an x.com status URL', () => {
    const result = classifyXStatusUrl('https://x.com/alice/status/1234567890')
    expect(result).toEqual({
      screenName: 'alice',
      statusId: '1234567890',
      canonical: 'x-status:1234567890',
    })
  })

  it('classifies a legacy twitter.com status URL', () => {
    const result = classifyXStatusUrl('https://twitter.com/bob/status/9876543210')
    expect(result).toEqual({
      screenName: 'bob',
      statusId: '9876543210',
      canonical: 'x-status:9876543210',
    })
  })

  it('classifies www./mobile. subdomains of x.com', () => {
    expect(classifyXStatusUrl('https://www.x.com/alice/status/111')).toEqual({
      screenName: 'alice',
      statusId: '111',
      canonical: 'x-status:111',
    })
    expect(classifyXStatusUrl('https://mobile.twitter.com/alice/status/222')).toEqual({
      screenName: 'alice',
      statusId: '222',
      canonical: 'x-status:222',
    })
  })

  it('ignores query parameters when canonicalizing', () => {
    const result = classifyXStatusUrl('https://x.com/alice/status/333?s=46')
    expect(result?.canonical).toBe('x-status:333')
  })

  it('returns null for a non-x.com host', () => {
    expect(classifyXStatusUrl('https://example.com/alice/status/123')).toBeNull()
  })

  it('returns null for an x.com URL that is not a status path', () => {
    expect(classifyXStatusUrl('https://x.com/alice')).toBeNull()
    expect(classifyXStatusUrl('https://x.com/alice/media')).toBeNull()
  })

  it('returns null for a malformed URL', () => {
    expect(classifyXStatusUrl('not a url')).toBeNull()
  })

  it('returns null for a non-http(s) protocol', () => {
    expect(classifyXStatusUrl('ftp://x.com/alice/status/123')).toBeNull()
  })
})
