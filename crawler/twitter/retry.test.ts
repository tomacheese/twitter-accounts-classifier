import { describe, expect, it, vi } from 'vitest'
import { isRetryableTwitterError, withTwitterRetry } from './retry'

function responseError(status: number): Error {
  const error = new Error(`response error ${String(status)}`)
  error.name = 'ResponseError'
  ;(error as unknown as { response: { status: number } }).response = { status }
  return error
}

function fetchError(): Error {
  const error = new Error('fetch failed')
  error.name = 'FetchError'
  return error
}

describe('isRetryableTwitterError', () => {
  it('treats 429 and 5xx ResponseErrors as retryable', () => {
    expect(isRetryableTwitterError(responseError(429))).toBe(true)
    expect(isRetryableTwitterError(responseError(500))).toBe(true)
    expect(isRetryableTwitterError(responseError(503))).toBe(true)
  })

  it('treats 4xx ResponseErrors other than 429 as not retryable', () => {
    expect(isRetryableTwitterError(responseError(401))).toBe(false)
    expect(isRetryableTwitterError(responseError(404))).toBe(false)
  })

  it('treats FetchErrors as retryable', () => {
    expect(isRetryableTwitterError(fetchError())).toBe(true)
  })

  it('treats plain errors and non-errors as not retryable', () => {
    expect(isRetryableTwitterError(new Error('boom'))).toBe(false)
    expect(isRetryableTwitterError('boom')).toBe(false)
  })
})

describe('withTwitterRetry', () => {
  it('returns the result on first success without sleeping', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const fn = vi.fn().mockResolvedValue('ok')

    const result = await withTwitterRetry(fn, { sleepImpl })

    expect(result).toBe('ok')
    expect(sleepImpl).not.toHaveBeenCalled()
  })

  it('retries a retryable failure and succeeds within maxAttempts', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const fn = vi.fn().mockRejectedValueOnce(responseError(429)).mockResolvedValueOnce('ok')

    const result = await withTwitterRetry(fn, { maxAttempts: 3, delayMs: 10, sleepImpl })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(sleepImpl).toHaveBeenCalledWith(10)
  })

  it('rethrows immediately without sleeping when the error is not retryable', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const error = responseError(404)
    const fn = vi.fn().mockRejectedValue(error)

    await expect(withTwitterRetry(fn, { sleepImpl })).rejects.toBe(error)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleepImpl).not.toHaveBeenCalled()
  })

  it('rethrows the last error once maxAttempts is exhausted', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const error = fetchError()
    const fn = vi.fn().mockRejectedValue(error)

    await expect(withTwitterRetry(fn, { maxAttempts: 2, sleepImpl })).rejects.toBe(error)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(sleepImpl).toHaveBeenCalledTimes(1)
  })
})
