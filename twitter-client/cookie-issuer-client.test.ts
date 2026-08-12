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

  it('本番と同様の約 110.7 秒の busy 区間を経ても既定値の retry budget 内で成功する', async () => {
    const busyUntilMs = 110_700
    let elapsedMs = 0
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          elapsedMs < busyUntilMs
            ? new Response('busy', { status: 409 })
            : jsonResponse({ status: 'ok', ct0: 'c0', auth_token: 'a0' }),
        ),
      )
    const sleepImpl = vi.fn().mockImplementation((ms: number) => {
      elapsedMs += ms
      return Promise.resolve()
    })
    const client = createCookieIssuerClient({
      baseUrl: 'http://issuer.local',
      fetchImpl,
      sleepImpl,
    })

    const cookies = await client.issueCookiesWithRetry({
      username: 'x',
      password: 'y',
      otp_secret: null,
    })

    expect(cookies).toEqual({ ct0: 'c0', authToken: 'a0' })
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(10)
  })

  it('既定の maxAttempts を使い切った場合、busy と識別できるメッセージで失敗する', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('busy', { status: 409 })))
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const client = createCookieIssuerClient({
      baseUrl: 'http://issuer.local',
      fetchImpl,
      sleepImpl,
    })

    const error = await client
      .issueCookiesWithRetry({ username: 'x', password: 'y', otp_secret: null })
      .catch((error_: unknown) => error_)

    expect(error).toBeInstanceOf(CookieIssuerError)
    expect((error as CookieIssuerError).status).toBe(409)
    expect((error as Error).message).toMatch(
      /^Cookie Issuer busy: exhausted 10 attempts over \d+ms \(last status 409\)$/,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(10)
  })

  it('maxAttempts を増やしても maxTotalWaitMs に達したら停止し、busy と識別できるメッセージで失敗する', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('busy', { status: 409 })))
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const client = createCookieIssuerClient({
      baseUrl: 'http://issuer.local',
      fetchImpl,
      sleepImpl,
    })

    const error = await client
      .issueCookiesWithRetry(
        { username: 'x', password: 'y', otp_secret: null },
        { maxAttempts: 100, delayMs: 3000, maxTotalWaitMs: 150_000 },
      )
      .catch((error_: unknown) => error_)

    expect(error).toBeInstanceOf(CookieIssuerError)
    expect((error as CookieIssuerError).status).toBe(409)
    expect((error as Error).message).toMatch(
      /^Cookie Issuer busy: exhausted 10 attempts over 135000ms \(last status 409\)$/,
    )
    // maxAttempts=100 でも maxTotalWaitMs の分岐で止まるため、実際の fetch 回数は maxAttempts より少なくなる
    expect(fetchImpl).toHaveBeenCalledTimes(10)
  })

  it('clientName を指定した場合、X-Client-Name header を付与する', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 'ok', ct0: 'c0', auth_token: 'a0' }))
    const client = createCookieIssuerClient({
      baseUrl: 'http://issuer.local',
      clientName: 'crawler',
      fetchImpl,
    })

    await client.issueCookies({ username: 'x', password: 'y', otp_secret: null })

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://issuer.local/login',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Client-Name': 'crawler' }),
      }),
    )
  })

  it('clientName を指定しない場合、X-Client-Name header を付与しない', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 'ok', ct0: 'c0', auth_token: 'a0' }))
    const client = createCookieIssuerClient({ baseUrl: 'http://issuer.local', fetchImpl })

    await client.issueCookies({ username: 'x', password: 'y', otp_secret: null })

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(init.headers).not.toHaveProperty('X-Client-Name')
  })
})
