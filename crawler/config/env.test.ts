import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCookieIssuerBaseUrl,
  getCrawlIntervalSeconds,
  getCrawlStaleThresholdMultiplier,
  getCrawlWarningThreshold,
  getRelabelerProducerBatchSize,
  getRelabelerWorkerBatchSize,
  getRelabelerWorkerConcurrency,
  getWeeklyAnalysisStaleThresholdSeconds,
} from './env'

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

describe('getRelabelerProducerBatchSize', () => {
  const originalValue = process.env.RELABELER_PRODUCER_BATCH_SIZE

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.RELABELER_PRODUCER_BATCH_SIZE
    } else {
      process.env.RELABELER_PRODUCER_BATCH_SIZE = originalValue
    }
  })

  it('returns 5000 when unset', () => {
    delete process.env.RELABELER_PRODUCER_BATCH_SIZE
    expect(getRelabelerProducerBatchSize()).toBe(5000)
  })

  it('returns the configured value', () => {
    process.env.RELABELER_PRODUCER_BATCH_SIZE = '1000'
    expect(getRelabelerProducerBatchSize()).toBe(1000)
  })

  it('throws when the value is not a positive integer', () => {
    process.env.RELABELER_PRODUCER_BATCH_SIZE = '0'
    expect(() => getRelabelerProducerBatchSize()).toThrow(
      'RELABELER_PRODUCER_BATCH_SIZE environment variable must be a positive integer',
    )
  })
})

describe('getRelabelerWorkerBatchSize', () => {
  const originalValue = process.env.RELABELER_WORKER_BATCH_SIZE

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.RELABELER_WORKER_BATCH_SIZE
    } else {
      process.env.RELABELER_WORKER_BATCH_SIZE = originalValue
    }
  })

  it('returns 2000 when unset', () => {
    delete process.env.RELABELER_WORKER_BATCH_SIZE
    expect(getRelabelerWorkerBatchSize()).toBe(2000)
  })

  it('returns the configured value', () => {
    process.env.RELABELER_WORKER_BATCH_SIZE = '500'
    expect(getRelabelerWorkerBatchSize()).toBe(500)
  })

  it('throws when the value is not a positive integer', () => {
    process.env.RELABELER_WORKER_BATCH_SIZE = '-1'
    expect(() => getRelabelerWorkerBatchSize()).toThrow(
      'RELABELER_WORKER_BATCH_SIZE environment variable must be a positive integer',
    )
  })
})

describe('getRelabelerWorkerConcurrency', () => {
  const originalValue = process.env.RELABELER_WORKER_CONCURRENCY

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.RELABELER_WORKER_CONCURRENCY
    } else {
      process.env.RELABELER_WORKER_CONCURRENCY = originalValue
    }
  })

  it('returns 1 when unset', () => {
    delete process.env.RELABELER_WORKER_CONCURRENCY
    expect(getRelabelerWorkerConcurrency()).toBe(1)
  })

  it('returns the configured value', () => {
    process.env.RELABELER_WORKER_CONCURRENCY = '4'
    expect(getRelabelerWorkerConcurrency()).toBe(4)
  })

  it('throws when the value is not a positive integer', () => {
    process.env.RELABELER_WORKER_CONCURRENCY = '1.5'
    expect(() => getRelabelerWorkerConcurrency()).toThrow(
      'RELABELER_WORKER_CONCURRENCY environment variable must be a positive integer',
    )
  })
})

describe('getWeeklyAnalysisStaleThresholdSeconds', () => {
  const originalValue = process.env.WEEKLY_ANALYSIS_STALE_THRESHOLD_SECONDS

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.WEEKLY_ANALYSIS_STALE_THRESHOLD_SECONDS
    } else {
      process.env.WEEKLY_ANALYSIS_STALE_THRESHOLD_SECONDS = originalValue
    }
  })

  it('returns 7200 when unset', () => {
    delete process.env.WEEKLY_ANALYSIS_STALE_THRESHOLD_SECONDS
    expect(getWeeklyAnalysisStaleThresholdSeconds()).toBe(7200)
  })

  it('returns the configured value', () => {
    process.env.WEEKLY_ANALYSIS_STALE_THRESHOLD_SECONDS = '3600'
    expect(getWeeklyAnalysisStaleThresholdSeconds()).toBe(3600)
  })

  it('throws when the value is not a positive integer', () => {
    process.env.WEEKLY_ANALYSIS_STALE_THRESHOLD_SECONDS = '-1'
    expect(() => getWeeklyAnalysisStaleThresholdSeconds()).toThrow(
      'WEEKLY_ANALYSIS_STALE_THRESHOLD_SECONDS environment variable must be a positive integer',
    )
  })
})
