import { describe, expect, it, vi } from 'vitest'
import { notifyDiscord } from './discord-notifier'

describe('notifyDiscord', () => {
  it('skips sending when webhookUrl is null', async () => {
    const fetchImpl = vi.fn()

    await notifyDiscord(null, [{ username: 'alice', blockedCount: 1, failedCount: 0 }], fetchImpl)

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends one message containing a summary and per-account breakdown', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

    await notifyDiscord(
      'https://discord.example.com/webhooks/exampleXXXX',
      [
        { username: 'alice', blockedCount: 3, failedCount: 1 },
        { username: 'bob', blockedCount: 0, failedCount: 0 },
      ],
      fetchImpl,
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://discord.example.com/webhooks/exampleXXXX')
    const body = JSON.parse((init as RequestInit).body as string) as { content: string }
    expect(body.content).toContain('alice')
    expect(body.content).toContain('bob')
    expect(body.content).toContain('3')
    expect(body.content).toContain('合計')
  })

  it('does not throw when the webhook request fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network error'))

    await expect(
      notifyDiscord(
        'https://discord.example.com/webhooks/exampleXXXX',
        [{ username: 'alice', blockedCount: 1, failedCount: 0 }],
        fetchImpl,
      ),
    ).resolves.toBeUndefined()
  })

  it('does not throw when Discord responds with a non-2xx status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }))

    await expect(
      notifyDiscord(
        'https://discord.example.com/webhooks/exampleXXXX',
        [{ username: 'alice', blockedCount: 1, failedCount: 0 }],
        fetchImpl,
      ),
    ).resolves.toBeUndefined()
  })
})
