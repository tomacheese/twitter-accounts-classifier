import { describe, expect, it, vi } from 'vitest'
import { createCycleTLSFetch, createOpenApiClientWith } from './client'

describe('createOpenApiClientWith', () => {
  it('passes ct0/auth_token through to getClientFromCookies', async () => {
    const getClientFromCookies = vi.fn().mockResolvedValue({ marker: 'client' })
    const fakeApi = { getClientFromCookies }

    const client = await createOpenApiClientWith(fakeApi as never, {
      ct0: 'c0',
      authToken: 'a0',
    })

    expect(getClientFromCookies).toHaveBeenCalledWith({ ct0: 'c0', auth_token: 'a0' })
    expect(client).toEqual({ marker: 'client' })
  })
})

describe('createCycleTLSFetch', () => {
  it('preserves CycleTLS response headers for case-insensitive diagnostic lookup', async () => {
    const cycleTLS = vi.fn().mockResolvedValue({
      data: 'rate limited',
      status: 429,
      headers: { 'X-Rate-Limit-Remaining': '0' },
    })
    const fetchImpl = createCycleTLSFetch(cycleTLS as never)

    const response = await fetchImpl('https://x.com/graphql/abc/HeaderPreservationTest')

    expect(response.headers.get('x-rate-limit-remaining')).toBe('0')
    expect(response.headers.get('X-RATE-LIMIT-REMAINING')).toBe('0')
  })
})

// `createOpenApiClient`・`createTrendsScraper` はここから先で別途検証する。実物の
// `cycletls` クライアントは外部プロセスを起動して遅くなるうえ、ここで検証したい
// 「渡す fetch がレスポンスをキャプチャすること」とは無関係なため、
// `cycletls`・`twitter-openapi-typescript`・`./trends-client` はモックにしている。
const { fakeCycleTLS } = vi.hoisted(() => {
  const fakeCycleTLSResponse = { data: '{"fake":true}', status: 200 }
  return {
    fakeCycleTLS: Object.assign(vi.fn().mockResolvedValue(fakeCycleTLSResponse), {
      exit: vi.fn(),
    }),
  }
})

vi.mock('cycletls', () => ({
  default: vi.fn().mockResolvedValue(fakeCycleTLS),
}))

vi.mock('twitter-openapi-typescript', () => ({
  TwitterOpenApi: class {
    static fetchApi: typeof fetch
    getClientFromCookies = vi.fn().mockResolvedValue({ marker: 'client' })
  },
}))

vi.mock('./trends-client', () => ({
  createTrendsClient: vi.fn().mockReturnValue({ marker: 'scraper' }),
}))

describe('createOpenApiClient', () => {
  it('assigns a response-capturing fetch to TwitterOpenApi.fetchApi', async () => {
    const { createOpenApiClient } = await import('./client')
    const { TwitterOpenApi } = await import('twitter-openapi-typescript')
    const { getLastResponseMatching } = await import('./response-capture')

    await createOpenApiClient({ ct0: 'c0', authToken: 'a0' })

    await TwitterOpenApi.fetchApi('https://x.com/graphql/abc/OpenApiWiringTest')

    expect(getLastResponseMatching('OpenApiWiringTest')).toMatchObject({
      body: '{"fake":true}',
    })
  })
})

describe('createTrendsScraper', () => {
  it('passes a response-capturing fetch through to createTrendsClient', async () => {
    const { createTrendsScraper } = await import('./client')
    const { createTrendsClient } = await import('./trends-client')
    const { getLastResponseMatching } = await import('./response-capture')

    await createTrendsScraper({ ct0: 'c0', authToken: 'a0' })

    const passedFetch = vi.mocked(createTrendsClient).mock.calls.at(-1)?.[1]
    expect(passedFetch).toBeDefined()
    await passedFetch?.('https://x.com/graphql/abc/TrendsWiringTest')

    expect(getLastResponseMatching('TrendsWiringTest')).toMatchObject({
      body: '{"fake":true}',
    })
  })
})
