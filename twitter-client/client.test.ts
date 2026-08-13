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

describe('createCycleTLSFetch timeout', () => {
  it('rejects with TimeoutError when the cycletls call never settles', async () => {
    const cycleTLS = vi.fn().mockReturnValue(
      new Promise(() => {
        // 意図的に永遠に settle しない: cycletls 子プロセスのハングを模する。
      }),
    )
    const fetchImpl = createCycleTLSFetch(cycleTLS as never, 5)

    await expect(fetchImpl('https://x.com/graphql/abc/HangingRequestTest')).rejects.toThrow(
      'did not complete within 5ms',
    )
  })
})

// `createOpenApiClient`・`createTrendsScraper` はここから先で別途検証する。
// 実物の `cycletls` クライアントは外部プロセスを起動して遅くなるうえ、
// ここで検証したい「渡す fetch がレスポンスをキャプチャすること」とは無関係なため、
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

const { getClientFromCookiesMock } = vi.hoisted(() => ({
  getClientFromCookiesMock: vi.fn().mockResolvedValue({ marker: 'client' }),
}))

vi.mock('twitter-openapi-typescript', () => ({
  TwitterOpenApi: class {
    static fetchApi: typeof fetch
    getClientFromCookies = getClientFromCookiesMock
  },
}))

vi.mock('./trends-client', () => ({
  createTrendsClient: vi.fn().mockReturnValue({ marker: 'scraper' }),
}))

vi.mock('./blocks-client', () => ({
  createBlocksClient: vi.fn().mockReturnValue({ getBlocksPage: vi.fn() }),
  createBlock: vi.fn().mockResolvedValue(undefined),
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

describe('createOpenApiClient timeout wiring', () => {
  it('propagates a custom timeoutMs to the underlying fetch', async () => {
    const { createOpenApiClient } = await import('./client')
    const { TwitterOpenApi } = await import('twitter-openapi-typescript')

    await createOpenApiClient({ ct0: 'c0', authToken: 'a0' }, 5)
    fakeCycleTLS.mockReturnValueOnce(
      new Promise(() => {
        // 意図的に永遠に settle しない。
      }),
    )

    await expect(
      TwitterOpenApi.fetchApi('https://x.com/graphql/abc/OpenApiTimeoutWiringTest'),
    ).rejects.toThrow('did not complete within 5ms')
  })
})

describe('createOpenApiClient port wiring', () => {
  it('passes the given port through to initCycleTLS', async () => {
    const { createOpenApiClient } = await import('./client')
    const cycletls = await import('cycletls')
    const initCycleTLS = cycletls.default as ReturnType<typeof vi.fn>

    await createOpenApiClient({ ct0: 'c0', authToken: 'a0' }, undefined, 20_123)

    expect(initCycleTLS).toHaveBeenCalledWith({ port: 20_123 })
  })

  it('omits the port option when no port is given', async () => {
    const { createOpenApiClient } = await import('./client')
    const cycletls = await import('cycletls')
    const initCycleTLS = cycletls.default as ReturnType<typeof vi.fn>

    await createOpenApiClient({ ct0: 'c0', authToken: 'a0' })

    expect(initCycleTLS).toHaveBeenCalledWith(undefined)
  })
})

describe('createOpenApiClient failure cleanup', () => {
  it('closes the cycletls handle when getClientFromCookies fails after initCycleTLS succeeds', async () => {
    const { createOpenApiClient } = await import('./client')
    const exitCallsBefore = fakeCycleTLS.exit.mock.calls.length
    getClientFromCookiesMock.mockRejectedValueOnce(new Error('network unreachable'))

    await expect(createOpenApiClient({ ct0: 'c0', authToken: 'a0' })).rejects.toThrow(
      'network unreachable',
    )

    expect(fakeCycleTLS.exit.mock.calls.length).toBe(exitCallsBefore + 1)
  })
})

describe('createOpenApiClient blocksClient/createBlock wiring', () => {
  it('exposes a raw blocks client and a bound createBlock function', async () => {
    const { createOpenApiClient } = await import('./client')

    const context = await createOpenApiClient({ ct0: 'c0', authToken: 'a0' })

    expect(typeof context.blocksClient.getBlocksPage).toBe('function')
    expect(typeof context.createBlock).toBe('function')
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

describe('createTrendsScraper port wiring', () => {
  it('passes the given port through to initCycleTLS', async () => {
    const { createTrendsScraper } = await import('./client')
    const cycletls = await import('cycletls')
    const initCycleTLS = cycletls.default as ReturnType<typeof vi.fn>

    await createTrendsScraper({ ct0: 'c0', authToken: 'a0' }, undefined, 20_456)

    expect(initCycleTLS).toHaveBeenCalledWith({ port: 20_456 })
  })
})

describe('createOpenApiClientSession', () => {
  it('keeps one CycleTLS transport alive until the session is closed', async () => {
    const { createOpenApiClientSession, closeOpenApiClient } = await import('./client')
    const cycletls = await import('cycletls')
    const initCycleTLS = cycletls.default as ReturnType<typeof vi.fn>
    const initCallsBefore = initCycleTLS.mock.calls.length
    const exitCallsBefore = fakeCycleTLS.exit.mock.calls.length

    const session = await createOpenApiClientSession()
    const first = await session.createOpenApiClient({ ct0: 'c1', authToken: 'a1' })
    await closeOpenApiClient(first)
    const second = await session.createOpenApiClient({ ct0: 'c2', authToken: 'a2' })
    await closeOpenApiClient(second)

    expect(initCycleTLS.mock.calls.length).toBe(initCallsBefore + 1)
    expect(fakeCycleTLS.exit.mock.calls.length).toBe(exitCallsBefore)

    await session.close()
    await session.close()

    expect(fakeCycleTLS.exit.mock.calls.length).toBe(exitCallsBefore + 1)
  })
})
