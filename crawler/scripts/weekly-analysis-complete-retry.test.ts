import { describe, expect, it, vi } from 'vitest'
import {
  isRetryableWeeklyAnalysisCompleteError,
  retryWeeklyAnalysisComplete,
} from './weekly-analysis-complete-retry'

describe('isRetryableWeeklyAnalysisCompleteError', () => {
  it.each([
    new Error('permission denied for table AnalysisWorkItem'),
    new Error('FATAL: the database system is shutting down'),
    Object.assign(new Error("Can't reach database server"), { code: 'P1001' }),
    Object.assign(new Error('Server has closed the connection'), { code: 'P1017' }),
  ])('accepts transient deployment/database error %#', (error) => {
    expect(isRetryableWeeklyAnalysisCompleteError(error)).toBe(true)
  })

  it.each([
    new Error('permission denied for table WeeklyAnalysisRun'),
    new Error('validation failed'),
    Object.assign(new Error('unique constraint'), { code: 'P2002' }),
  ])('rejects non-transient error %#', (error) => {
    expect(isRetryableWeeklyAnalysisCompleteError(error)).toBe(false)
  })
})

describe('retryWeeklyAnalysisComplete', () => {
  it('retries a transient error and returns the later result', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('permission denied for table AnalysisWorkItem'))
      .mockResolvedValueOnce('ok')
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    await expect(
      retryWeeklyAnalysisComplete(operation, { maxAttempts: 3, delayMs: 1, sleep }),
    ).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('does not retry an unrelated error', async () => {
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('bad input'))
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    await expect(
      retryWeeklyAnalysisComplete(operation, { maxAttempts: 3, delayMs: 1, sleep }),
    ).rejects.toThrow('bad input')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('stops after the configured attempt limit', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('permission denied for table AnalysisWorkItem'))
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    await expect(
      retryWeeklyAnalysisComplete(operation, { maxAttempts: 3, delayMs: 1, sleep }),
    ).rejects.toThrow('permission denied for table AnalysisWorkItem')
    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})
