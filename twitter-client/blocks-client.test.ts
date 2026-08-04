import { describe, expect, it, vi } from 'vitest'
import { createBlock, createBlocksClient } from './blocks-client'

const cookies = { ct0: 'csrf-token', authToken: 'auth-token-value' }

function rawTimelineUser(restId: string) {
  return {
    rest_id: restId,
    core: {
      screen_name: `user_${restId}`,
      name: `User ${restId}`,
      created_at: 'Wed Jan 01 00:00:00 +0000 2020',
    },
    legacy: {
      followers_count: 10,
      friends_count: 5,
      statuses_count: 20,
      profile_image_url_https: null,
      location: null,
      url: null,
    },
    profile_bio: { description: 'example bio text' },
    is_blue_verified: false,
    verification: { verified_type: null },
    professional: { professional_type: null },
    parody_commentary_fan_label: null,
  }
}

function timelineResponse(userIds: string[], nextCursor: string | undefined) {
  const userEntries = userIds.map((id) => ({
    entryId: `user-${id}`,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: { user_results: { result: rawTimelineUser(id) } },
    },
  }))
  const cursorEntries = [
    {
      entryId: 'cursor-top',
      content: {
        entryType: 'TimelineTimelineCursor',
        cursorType: 'Top',
        value: 'top-cursor',
      },
    },
    {
      entryId: 'cursor-bottom',
      content: {
        entryType: 'TimelineTimelineCursor',
        cursorType: 'Bottom',
        value: nextCursor,
      },
    },
  ]
  return {
    data: {
      viewer: {
        timeline: {
          timeline: {
            instructions: [
              { instructionType: 'TimelineClearCache' },
              { instructionType: 'TimelineTerminateTimeline' },
              { entries: [...userEntries, ...cursorEntries] },
            ],
          },
        },
      },
    },
  }
}

describe('createBlocksClient', () => {
  it('attaches csrf token, cookies, and bearer auth, and parses users plus the next cursor', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(timelineResponse(['1'], 'next-cursor-value'), { status: 200 }),
      )

    const client = createBlocksClient(cookies, fetchImpl as unknown as typeof fetch)
    const page = await client.getBlocksPage(undefined, 200)

    expect(page.users.map((user) => user.restId)).toEqual(['1'])
    expect(page.users[0].legacy.screenName).toBe('user_1')
    expect(page.users[0].legacy.description).toBe('example bio text')
    expect(page.nextCursor).toBe('next-cursor-value')

    const [url, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://x.com/i/api/graphql/5oNXfRkE7HVkDX1Fd1gn3g/BlockedAccountsAll')
    const headers = requestInit.headers as Record<string, string>
    expect(headers.authorization).toMatch(/^Bearer /)
    expect(headers['x-csrf-token']).toBe('csrf-token')
    expect(headers.cookie).toBe('ct0=csrf-token; auth_token=auth-token-value')
  })

  it('omits nextCursor when the response carries no bottom cursor value', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(timelineResponse(['2'], undefined), { status: 200 }))

    const client = createBlocksClient(cookies, fetchImpl as unknown as typeof fetch)
    const page = await client.getBlocksPage(undefined, 200)

    expect(page.nextCursor).toBeUndefined()
  })

  it('throws when the endpoint responds with an error status', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('error body', { status: 403 }))

    const client = createBlocksClient(cookies, fetchImpl as unknown as typeof fetch)

    await expect(client.getBlocksPage(undefined, 200)).rejects.toThrow(/403.*error body/)
  })
})

describe('createBlock', () => {
  it('sends user_id as form-encoded body and resolves on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))

    await createBlock(cookies, fetchImpl as unknown as typeof fetch, '999')

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://x.com/i/api/1.1/blocks/create.json',
      expect.objectContaining({
        method: 'POST',
        body: 'user_id=999',
      }),
    )
  })

  it('throws a BlocksResponseError carrying the status on non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }))

    await expect(
      createBlock(cookies, fetchImpl as unknown as typeof fetch, '999'),
    ).rejects.toMatchObject({ name: 'ResponseError', response: { status: 403 } })
  })
})
