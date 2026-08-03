import { describe, expect, it, vi } from 'vitest'
import { createTrendsClient } from './trends-client'

const cookies = { ct0: 'csrf-token', authToken: 'auth-token-value' }

function guideJsonBody(trendNames: string[]): unknown {
  return {
    timeline: {
      instructions: [
        {},
        {
          addEntries: {
            entries: [
              {},
              {
                content: {
                  timelineModule: {
                    items: trendNames.map((trendName) => ({
                      item: {
                        clientEventInfo: {
                          details: {
                            guideDetails: {
                              transparentGuideDetails: { trendMetadata: { trendName } },
                            },
                          },
                        },
                      },
                    })),
                  },
                },
              },
            ],
          },
        },
      ],
    },
  }
}

describe('createTrendsClient', () => {
  it('activates a guest token, then attaches it alongside cookies when fetching guide.json', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ guest_token: 'guest-123' }, { status: 200 }))
      .mockResolvedValueOnce(Response.json(guideJsonBody(['#foo', '#bar']), { status: 200 }))

    const client = createTrendsClient(cookies, fetchImpl as unknown as typeof fetch)
    const trends = await client.getTrends()

    expect(trends).toEqual(['#foo', '#bar'])
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.x.com/1.1/guest/activate.json',
      expect.objectContaining({ method: 'POST' }),
    )
    const [, guideRequestInit] = fetchImpl.mock.calls[1] as [string, RequestInit]
    const guideHeaders = guideRequestInit.headers as Record<string, string>
    expect(guideHeaders['x-guest-token']).toBe('guest-123')
    expect(guideHeaders['x-csrf-token']).toBe('csrf-token')
    expect(guideHeaders.cookie).toBe('ct0=csrf-token; auth_token=auth-token-value')
  })

  it('throws when guest token activation fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 }))

    const client = createTrendsClient(cookies, fetchImpl as unknown as typeof fetch)

    await expect(client.getTrends()).rejects.toThrow(/guest token/i)
  })

  it('throws when guide.json returns no trend entries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ guest_token: 'guest-123' }, { status: 200 }))
      .mockResolvedValueOnce(Response.json(guideJsonBody([]), { status: 200 }))

    const client = createTrendsClient(cookies, fetchImpl as unknown as typeof fetch)

    await expect(client.getTrends()).rejects.toThrow(/no trend entries/i)
  })

  it('throws when guide.json itself responds with an error status', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ guest_token: 'guest-123' }, { status: 200 }))
      .mockResolvedValueOnce(new Response('error body', { status: 400 }))

    const client = createTrendsClient(cookies, fetchImpl as unknown as typeof fetch)

    await expect(client.getTrends()).rejects.toThrow(/400.*error body/)
  })

  it('throws a schema-drift error, distinct from "no trends", when guide.json changes shape', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ guest_token: 'guest-123' }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ timeline: { instructions: [{}] } }, { status: 200 }))

    const client = createTrendsClient(cookies, fetchImpl as unknown as typeof fetch)

    await expect(client.getTrends()).rejects.toThrow(/unexpected guide\.json response shape/i)
  })
})
