import { describe, expect, it, vi } from 'vitest'
import { createCookieIssuerClient, CookieIssuerError } from './cookie-issuer-client'

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createCookieIssuerClient', () => {
  it('returns cookies parsed from a successful response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 'ok', ct0: 'c0', auth_token: 'a0' }))
    const client = createCookieIssuerClient({ baseUrl: 'http://issuer.local', fetchImpl })

    const cookies = await client.issueCookies({
      username: 'test_user',
      password: 'secret',
      otp_secret: null,
    })

    expect(cookies).toEqual({ ct0: 'c0', authToken: 'a0' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://issuer.local/login',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('throws CookieIssuerError with the status code on non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad credentials', { status: 500 }))
    const client = createCookieIssuerClient({ baseUrl: 'http://issuer.local', fetchImpl })

    const error = await client
      .issueCookies({ username: 'x', password: 'y', otp_secret: null })
      .catch((error_: unknown) => error_)
    expect(error).toBeInstanceOf(CookieIssuerError)
    expect(error).toMatchObject({ status: 500 })
  })

  it('retries on 409 (login already in progress) up to the attempt limit', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 409 }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', ct0: 'c0', auth_token: 'a0' }))
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const client = createCookieIssuerClient({
      baseUrl: 'http://issuer.local',
      fetchImpl,
      sleepImpl,
    })

    const cookies = await client.issueCookiesWithRetry(
      { username: 'x', password: 'y', otp_secret: null },
      { maxAttempts: 3, delayMs: 10 },
    )

    expect(cookies).toEqual({ ct0: 'c0', authToken: 'a0' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleepImpl).toHaveBeenCalledWith(10)
  })
})
