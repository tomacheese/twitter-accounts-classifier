import { describe, expect, it, vi } from 'vitest'
import { isRetryableTwitterError, withTwitterRetry } from './retry'

function responseError(status: number): Error {
  const error = new Error(`response error ${String(status)}`)
  error.name = 'ResponseError'
  ;(error as unknown as { response: { status: number } }).response = { status }
  return error
}

function rateLimitedError(headers: Headers): Error {
  const error = responseError(429)
  ;(error as unknown as { response: { status: number; headers: Headers } }).response.headers =
    headers
  return error
}

function fetchError(): Error {
  const error = new Error('fetch failed')
  error.name = 'FetchError'
  return error
}

describe('isRetryableTwitterError', () => {
  it('treats 408 and 5xx ResponseErrors as retryable', () => {
    expect(isRetryableTwitterError(responseError(408))).toBe(true)
    expect(isRetryableTwitterError(responseError(500))).toBe(true)
    expect(isRetryableTwitterError(responseError(503))).toBe(true)
  })

  it('does not send 429 responses through fixed-delay retry scheduling', () => {
    expect(isRetryableTwitterError(responseError(429))).toBe(false)
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
    const fn = vi.fn().mockRejectedValueOnce(responseError(500)).mockResolvedValueOnce('ok')

    const result = await withTwitterRetry(fn, { maxAttempts: 3, delayMs: 10, sleepImpl })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(sleepImpl).toHaveBeenCalledWith(10)
  })

  it('rethrows a 429 without fixed-delay retrying', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const error = responseError(429)
    const fn = vi.fn().mockRejectedValue(error)

    await expect(withTwitterRetry(fn, { sleepImpl })).rejects.toBe(error)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleepImpl).not.toHaveBeenCalled()
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

describe('withTwitterRateLimitRetry', () => {
  it('waits once using Retry-After before retrying a priority request', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitedError(new Headers({ 'retry-after': '60' })))
      .mockResolvedValueOnce('ok')

    const { withTwitterRateLimitRetry } = await import('./retry')
    await expect(withTwitterRateLimitRetry(fn, { sleepImpl })).resolves.toBe('ok')
    expect(sleepImpl).toHaveBeenCalledWith(60_000)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not retry a priority request when reset wait exceeds 60 seconds', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const error = rateLimitedError(new Headers({ 'retry-after': '61' }))
    const fn = vi.fn().mockRejectedValue(error)

    const { withTwitterRateLimitRetry } = await import('./retry')
    await expect(withTwitterRateLimitRetry(fn, { sleepImpl })).rejects.toBe(error)
    expect(sleepImpl).not.toHaveBeenCalled()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
