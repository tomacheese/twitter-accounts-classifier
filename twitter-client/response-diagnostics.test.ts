import { describe, expect, it } from 'vitest'
import {
  formatResponseErrorDiagnostics,
  getResponseErrorDiagnostics,
  toSafeResponseErrorForLog,
} from './response-diagnostics'

function responseError(status: unknown, headers: unknown = new Headers()): Error {
  const error = new Error('Response returned an error code')
  error.name = 'ResponseError'
  ;(error as unknown as { response: { status: unknown; headers: unknown } }).response = {
    status,
    headers,
  }
  return error
}

describe('getResponseErrorDiagnostics', () => {
  it('extracts only valid allow-listed numeric response headers', () => {
    const diagnostics = getResponseErrorDiagnostics(
      responseError(
        429,
        new Headers({
          'Retry-After': ' 60 ',
          'X-Rate-Limit-Limit': '100',
          'X-Rate-Limit-Remaining': '0',
          'X-Rate-Limit-Reset': '1760000000',
          authorization: 'Bearer diagnostic-test-token',
          cookie: 'session=diagnostic-test-cookie',
          'set-cookie': 'session=diagnostic-test-cookie',
          'x-unrelated-header': 'diagnostic-test-secret',
        }),
      ),
    )

    expect(diagnostics).toEqual({
      httpStatus: 429,
      retryAfterSeconds: 60,
      rateLimitLimit: 100,
      rateLimitRemaining: 0,
      rateLimitReset: 1_760_000_000,
    })
    expect(JSON.stringify(diagnostics)).not.toContain('diagnostic-test')
  })

  it.each(['Wed, 21 Oct 2015 07:28:00 GMT', '1.5', '1e3', '-1', '', 'Infinity'])(
    'omits an invalid retry-after value of %j',
    (retryAfter) => {
      const diagnostics = getResponseErrorDiagnostics(
        responseError(429, new Headers({ 'retry-after': retryAfter })),
      )

      expect(diagnostics).toEqual({ httpStatus: 429 })
    },
  )

  it.each([99, 600, 429.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'omits diagnostics for an invalid HTTP status of %s',
    (status) => {
      expect(getResponseErrorDiagnostics(responseError(status))).toBeUndefined()
    },
  )

  it('omits malformed response headers and non-ResponseErrors', () => {
    const headers = {
      get: () => {
        throw new Error('broken headers')
      },
    }

    expect(getResponseErrorDiagnostics(responseError(500, headers))).toEqual({ httpStatus: 500 })
    expect(getResponseErrorDiagnostics(new Error('not a response error'))).toBeUndefined()
  })

  it('omits unavailable header properties instead of assigning undefined', () => {
    const diagnostics = getResponseErrorDiagnostics(
      responseError(429, new Headers({ 'retry-after': '60' })),
    )

    expect(diagnostics).toEqual({ httpStatus: 429, retryAfterSeconds: 60 })
    expect(diagnostics).not.toHaveProperty('rateLimitLimit')
    expect(diagnostics).not.toHaveProperty('rateLimitRemaining')
    expect(diagnostics).not.toHaveProperty('rateLimitReset')
  })
})

describe('toSafeResponseErrorForLog', () => {
  it('keeps stack frames without retaining the original message or response', () => {
    const error = responseError(429)
    error.message = 'response contained diagnostic-test-secret'
    error.stack = `ResponseError: ${error.message}\n    at test (response-diagnostics.test.ts:1:1)`
    const safeError = toSafeResponseErrorForLog(error)

    expect(safeError.message).toBe('ResponseError')
    expect(safeError.stack).toContain('at test (response-diagnostics.test.ts:1:1)')
    expect(safeError.stack).not.toContain('diagnostic-test-secret')
    expect(safeError).not.toHaveProperty('response')
  })
})

describe('formatResponseErrorDiagnostics', () => {
  it('formats only the fixed diagnostic fields', () => {
    const message = formatResponseErrorDiagnostics({
      httpStatus: 429,
      retryAfterSeconds: 60,
      rateLimitRemaining: 0,
    })

    expect(message).toBe('httpStatus=429, retryAfterSeconds=60, rateLimitRemaining=0')
    expect(message).not.toContain('cookie')
    expect(message).not.toContain('token')
  })
})
