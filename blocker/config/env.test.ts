import { afterEach, describe, expect, it } from 'vitest'
import {
  getCookieIssuerBaseUrl,
  getBlockIntervalSeconds,
  getBlockActionDelayMs,
  getBlockMaxPerAccountPerRun,
  getBlockTargetNotFoundMaxAttempts,
} from './env'

const ENV_KEYS = [
  'COOKIE_ISSUER_URL',
  'BLOCK_INTERVAL_SECONDS',
  'BLOCK_ACTION_DELAY_MS',
  'BLOCK_MAX_PER_ACCOUNT_PER_RUN',
  'BLOCK_TARGET_NOT_FOUND_MAX_ATTEMPTS',
] as const

afterEach(() => {
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key)
})

describe('getCookieIssuerBaseUrl', () => {
  it('throws when COOKIE_ISSUER_URL is unset', () => {
    expect(() => getCookieIssuerBaseUrl()).toThrow(/COOKIE_ISSUER_URL/)
  })

  it('returns the configured value', () => {
    process.env.COOKIE_ISSUER_URL = 'https://cookie-issuer.example.com'
    expect(getCookieIssuerBaseUrl()).toBe('https://cookie-issuer.example.com')
  })
})

describe('getBlockIntervalSeconds', () => {
  it('defaults to 21600 when unset', () => {
    expect(getBlockIntervalSeconds()).toBe(21_600)
  })

  it('returns the configured positive integer', () => {
    process.env.BLOCK_INTERVAL_SECONDS = '3600'
    expect(getBlockIntervalSeconds()).toBe(3600)
  })
})

describe('getBlockActionDelayMs', () => {
  it('defaults to 2000 when unset', () => {
    expect(getBlockActionDelayMs()).toBe(2000)
  })
})

describe('getBlockMaxPerAccountPerRun', () => {
  it('defaults to 50 when unset', () => {
    expect(getBlockMaxPerAccountPerRun()).toBe(50)
  })

  it('rejects a non-positive-integer value', () => {
    process.env.BLOCK_MAX_PER_ACCOUNT_PER_RUN = '-1'
    expect(() => getBlockMaxPerAccountPerRun()).toThrow(/positive integer/)
  })
})

describe('getBlockTargetNotFoundMaxAttempts', () => {
  it('defaults to 3 when unset', () => {
    expect(getBlockTargetNotFoundMaxAttempts()).toBe(3)
  })

  it('returns the configured positive integer', () => {
    process.env.BLOCK_TARGET_NOT_FOUND_MAX_ATTEMPTS = '5'
    expect(getBlockTargetNotFoundMaxAttempts()).toBe(5)
  })

  it('rejects a non-positive-integer value', () => {
    process.env.BLOCK_TARGET_NOT_FOUND_MAX_ATTEMPTS = '-1'
    expect(() => getBlockTargetNotFoundMaxAttempts()).toThrow(/positive integer/)
  })
})
