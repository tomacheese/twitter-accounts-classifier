import { describe, expect, it, vi } from 'vitest'
import { runBlockCycle } from './index'
import type { BlockerAppConfig } from './config/load-config'

describe('runBlockCycle', () => {
  it('skips accounts with block_enabled=false and runs the rest', async () => {
    const config: BlockerAppConfig = {
      accounts: [
        {
          email: 'a@example.com',
          username: 'alice',
          password: 'p',
          otpSecret: null,
          blockEnabled: true,
          blockRule: { targetLabels: ['spam'], confidenceThreshold: 0.8 },
        },
        {
          email: 'b@example.com',
          username: 'bob',
          password: 'p',
          otpSecret: null,
          blockEnabled: false,
          blockRule: null,
        },
      ],
      globalBlockRule: null,
      discordWebhookUrl: 'https://discord.example.com/webhooks/exampleXXXX',
    }
    const runBlockAccountCycle = vi
      .fn()
      .mockResolvedValue({ username: 'alice', blockedCount: 2, failedCount: 0 })
    const notifyDiscord = vi.fn().mockResolvedValue(undefined)
    const deps = {
      config,
      startBlockRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
      finishBlockRun: vi.fn().mockResolvedValue(undefined),
      touchBlockRunHeartbeat: vi.fn().mockResolvedValue(undefined),
      runBlockAccountCycle,
      notifyDiscord,
      prisma: {},
    }

    await runBlockCycle(deps as never)

    expect(runBlockAccountCycle).toHaveBeenCalledTimes(1)
    expect(runBlockAccountCycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ username: 'alice' }),
      config,
      'run-1',
    )
    expect(notifyDiscord).toHaveBeenCalledTimes(1)
    expect(notifyDiscord).toHaveBeenCalledWith(config.discordWebhookUrl, [
      { username: 'alice', blockedCount: 2, failedCount: 0 },
    ])
    expect(deps.finishBlockRun).toHaveBeenCalledWith(
      deps.prisma,
      'run-1',
      expect.any(Date),
      'completed',
    )
  })

  it('continues to the next account and still notifies when one account cycle throws', async () => {
    const config: BlockerAppConfig = {
      accounts: [
        {
          email: 'a@example.com',
          username: 'alice',
          password: 'p',
          otpSecret: null,
          blockEnabled: true,
          blockRule: { targetLabels: ['spam'], confidenceThreshold: 0.8 },
        },
      ],
      globalBlockRule: null,
      discordWebhookUrl: null,
    }
    const runBlockAccountCycle = vi.fn().mockRejectedValue(new Error('cookie issuer down'))
    const notifyDiscord = vi.fn().mockResolvedValue(undefined)
    const deps = {
      config,
      startBlockRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
      finishBlockRun: vi.fn().mockResolvedValue(undefined),
      touchBlockRunHeartbeat: vi.fn().mockResolvedValue(undefined),
      runBlockAccountCycle,
      notifyDiscord,
      prisma: {},
    }

    await runBlockCycle(deps as never)

    expect(notifyDiscord).toHaveBeenCalledWith(null, [
      { username: 'alice', blockedCount: 0, failedCount: 0 },
    ])
  })
})
