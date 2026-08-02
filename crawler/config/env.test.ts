import { afterEach, describe, expect, it } from 'vitest'
import {
  getCookieIssuerBaseUrl,
  getCrawlIntervalSeconds,
  getCrawlStaleThresholdMultiplier,
} from './env'

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

describe('getCrawlIntervalSeconds', () => {
  const originalValue = process.env.CRAWL_INTERVAL_SECONDS

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.CRAWL_INTERVAL_SECONDS
    } else {
      process.env.CRAWL_INTERVAL_SECONDS = originalValue
    }
  })

  it('returns 21600 when unset', () => {
    delete process.env.CRAWL_INTERVAL_SECONDS
    expect(getCrawlIntervalSeconds()).toBe(21_600)
  })

  it('returns the configured value', () => {
    process.env.CRAWL_INTERVAL_SECONDS = '3600'
    expect(getCrawlIntervalSeconds()).toBe(3600)
  })

  it('returns the default when set to an empty string', () => {
    process.env.CRAWL_INTERVAL_SECONDS = ''
    expect(getCrawlIntervalSeconds()).toBe(21_600)
  })

  it('throws when the value is not a positive integer', () => {
    process.env.CRAWL_INTERVAL_SECONDS = '0'
    expect(() => getCrawlIntervalSeconds()).toThrow(
      'CRAWL_INTERVAL_SECONDS environment variable must be a positive integer',
    )
  })

  it('throws when the value is not an integer', () => {
    process.env.CRAWL_INTERVAL_SECONDS = '1.5'
    expect(() => getCrawlIntervalSeconds()).toThrow(
      'CRAWL_INTERVAL_SECONDS environment variable must be a positive integer',
    )
  })

  it('throws when the value is exponential notation', () => {
    process.env.CRAWL_INTERVAL_SECONDS = '1e30'
    expect(() => getCrawlIntervalSeconds()).toThrow(
      'CRAWL_INTERVAL_SECONDS environment variable must be a positive integer',
    )
  })

  it('throws when the value is hexadecimal notation', () => {
    process.env.CRAWL_INTERVAL_SECONDS = '0x10'
    expect(() => getCrawlIntervalSeconds()).toThrow(
      'CRAWL_INTERVAL_SECONDS environment variable must be a positive integer',
    )
  })
})

describe('getCrawlStaleThresholdMultiplier', () => {
  const originalValue = process.env.CRAWL_STALE_THRESHOLD_MULTIPLIER

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.CRAWL_STALE_THRESHOLD_MULTIPLIER
    } else {
      process.env.CRAWL_STALE_THRESHOLD_MULTIPLIER = originalValue
    }
  })

  it('returns 3 when unset', () => {
    delete process.env.CRAWL_STALE_THRESHOLD_MULTIPLIER
    expect(getCrawlStaleThresholdMultiplier()).toBe(3)
  })

  it('returns the configured value', () => {
    process.env.CRAWL_STALE_THRESHOLD_MULTIPLIER = '5'
    expect(getCrawlStaleThresholdMultiplier()).toBe(5)
  })

  it('throws when the value is not a positive integer', () => {
    process.env.CRAWL_STALE_THRESHOLD_MULTIPLIER = '-1'
    expect(() => getCrawlStaleThresholdMultiplier()).toThrow(
      'CRAWL_STALE_THRESHOLD_MULTIPLIER environment variable must be a positive integer',
    )
  })
})
