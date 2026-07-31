import { afterEach, describe, expect, it } from 'vitest'
import { getCookieIssuerBaseUrl } from './env'

describe('getCookieIssuerBaseUrl', () => {
  const originalValue = process.env.COOKIE_ISSUER_URL

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.COOKIE_ISSUER_URL
    } else {
      process.env.COOKIE_ISSUER_URL = originalValue
    }
  })

  it('returns the configured value', () => {
    process.env.COOKIE_ISSUER_URL = 'http://example.test:7006'
    expect(getCookieIssuerBaseUrl()).toBe('http://example.test:7006')
  })

  it('throws when COOKIE_ISSUER_URL is unset', () => {
    delete process.env.COOKIE_ISSUER_URL
    expect(() => getCookieIssuerBaseUrl()).toThrow(
      'COOKIE_ISSUER_URL environment variable is required',
    )
  })
})
