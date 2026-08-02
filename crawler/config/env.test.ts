import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCookieIssuerBaseUrl, getCrawlWarningThreshold } from './env'

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }))
vi.mock('@book000/node-utils', () => ({
  Logger: { configure: () => ({ warn: warnMock }) },
}))

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

describe('getCrawlWarningThreshold', () => {
  const originalValue = process.env.CRAWL_WARNING_THRESHOLD

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.CRAWL_WARNING_THRESHOLD
    } else {
      process.env.CRAWL_WARNING_THRESHOLD = originalValue
    }
    warnMock.mockClear()
  })

  it('returns the default (5) when the environment variable is unset', () => {
    delete process.env.CRAWL_WARNING_THRESHOLD
    expect(getCrawlWarningThreshold()).toBe(5)
  })

  it('returns the default (5) when the environment variable is empty', () => {
    process.env.CRAWL_WARNING_THRESHOLD = ''
    expect(getCrawlWarningThreshold()).toBe(5)
  })

  it('returns the parsed integer when a valid positive integer is set', () => {
    process.env.CRAWL_WARNING_THRESHOLD = '10'
    expect(getCrawlWarningThreshold()).toBe(10)
  })

  it('falls back to the default and logs a warning for a non-numeric value', () => {
    process.env.CRAWL_WARNING_THRESHOLD = 'not-a-number'
    expect(getCrawlWarningThreshold()).toBe(5)
    expect(warnMock).toHaveBeenCalled()
  })

  it('falls back to the default for a non-integer decimal value', () => {
    process.env.CRAWL_WARNING_THRESHOLD = '5.5'
    expect(getCrawlWarningThreshold()).toBe(5)
    expect(warnMock).toHaveBeenCalled()
  })

  it('falls back to the default for zero', () => {
    process.env.CRAWL_WARNING_THRESHOLD = '0'
    expect(getCrawlWarningThreshold()).toBe(5)
    expect(warnMock).toHaveBeenCalled()
  })

  it('falls back to the default for a negative value', () => {
    process.env.CRAWL_WARNING_THRESHOLD = '-1'
    expect(getCrawlWarningThreshold()).toBe(5)
    expect(warnMock).toHaveBeenCalled()
  })
})
