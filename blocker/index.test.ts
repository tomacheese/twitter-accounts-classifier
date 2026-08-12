import { describe, expect, it, vi, beforeEach } from 'vitest'
import { runBlockCycle } from './index'
import type { BlockerAppConfig } from './config/load-config'

const issueCookiesWithRetry = vi.fn()
vi.mock('twitter-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('twitter-client')>()
  return {
    ...actual,
    createCookieIssuerClient: vi.fn(() => ({
      issueCookies: vi.fn(),
      issueCookiesWithRetry,
    })),
  }
})

beforeEach(() => {
  process.env.COOKIE_ISSUER_URL = 'https://cookie-issuer.example.com'
  issueCookiesWithRetry.mockReset()
})

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
          blockRule: { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
        },
        {
          email: 'b@example.com',
          username: 'bob',
          password: 'p',
          otpSecret: null,
          blockEnabled: false,
        },
      ],
      discordWebhookUrl: 'https://discord.example.com/webhooks/exampleXXXX',
    }
    const runBlockAccountCycle = vi
      .fn()
      .mockResolvedValue({ username: 'alice', blockedCount: 2, failedCount: 0, failed: false })
    const notifyDiscord = vi.fn().mockResolvedValue(undefined)
    const reconcileAccountOutbox = vi.fn().mockResolvedValue(undefined)
    const deps = {
      config,
      startOrResumeBlockRun: vi.fn().mockResolvedValue({ id: 'run-1', completedUsernames: [] }),
      finishBlockRun: vi.fn().mockResolvedValue(undefined),
      touchBlockRunHeartbeat: vi.fn().mockResolvedValue(undefined),
      runBlockAccountCycle,
      notifyDiscord,
      reconcileAccountOutbox,
      prisma: {},
    }

    await runBlockCycle(deps as never)

    expect(runBlockAccountCycle).toHaveBeenCalledTimes(1)
    expect(runBlockAccountCycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ username: 'alice' }),
      'run-1',
    )
    expect(notifyDiscord).toHaveBeenCalledTimes(1)
    expect(notifyDiscord).toHaveBeenCalledWith(config.discordWebhookUrl, [
      { username: 'alice', blockedCount: 2, failedCount: 0, failed: false },
    ])
    expect(deps.finishBlockRun).toHaveBeenCalledWith(
      deps.prisma,
      'run-1',
      expect.any(Date),
      'completed',
    )
    expect(reconcileAccountOutbox).toHaveBeenCalledTimes(1)
    expect(reconcileAccountOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'alice' }),
      deps.prisma,
      undefined,
    )
  })

  it('resume した BlockRun では completed 済み username を再処理しない', async () => {
    const config: BlockerAppConfig = {
      accounts: [
        {
          email: 'a@example.com',
          username: 'alice',
          password: 'p',
          otpSecret: null,
          blockEnabled: true,
          blockRule: { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
        },
        {
          email: 'b@example.com',
          username: 'bob',
          password: 'p',
          otpSecret: null,
          blockEnabled: true,
          blockRule: { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
        },
      ],
      discordWebhookUrl: null,
    }
    const runBlockAccountCycle = vi
      .fn()
      .mockResolvedValue({ username: 'bob', blockedCount: 1, failedCount: 0, failed: false })
    const deps = {
      config,
      startOrResumeBlockRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        completedUsernames: ['alice'],
      }),
      finishBlockRun: vi.fn().mockResolvedValue(undefined),
      touchBlockRunHeartbeat: vi.fn().mockResolvedValue(undefined),
      runBlockAccountCycle,
      notifyDiscord: vi.fn().mockResolvedValue(undefined),
      prisma: {},
    }

    await runBlockCycle(deps as never)

    expect(runBlockAccountCycle).toHaveBeenCalledTimes(1)
    expect(runBlockAccountCycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ username: 'bob' }),
      'run-1',
    )
    expect(deps.notifyDiscord).toHaveBeenCalledWith(null, [
      { username: 'bob', blockedCount: 1, failedCount: 0, failed: false },
    ])
    expect(deps.finishBlockRun).toHaveBeenCalledWith(
      deps.prisma,
      'run-1',
      expect.any(Date),
      'completed',
    )
  })

  it('continues to the next account, notifies, and marks the run failed when one account cycle throws', async () => {
    const config: BlockerAppConfig = {
      accounts: [
        {
          email: 'a@example.com',
          username: 'alice',
          password: 'p',
          otpSecret: null,
          blockEnabled: true,
          blockRule: { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
        },
      ],
      discordWebhookUrl: null,
    }
    const runBlockAccountCycle = vi.fn().mockRejectedValue(new Error('cookie issuer down'))
    const notifyDiscord = vi.fn().mockResolvedValue(undefined)
    const deps = {
      config,
      startOrResumeBlockRun: vi.fn().mockResolvedValue({ id: 'run-1', completedUsernames: [] }),
      finishBlockRun: vi.fn().mockResolvedValue(undefined),
      touchBlockRunHeartbeat: vi.fn().mockResolvedValue(undefined),
      runBlockAccountCycle,
      notifyDiscord,
      reconcileAccountOutbox: vi.fn().mockResolvedValue(undefined),
      prisma: {},
    }

    await runBlockCycle(deps as never)

    expect(notifyDiscord).toHaveBeenCalledWith(null, [
      { username: 'alice', blockedCount: 0, failedCount: 0, failed: true },
    ])
    expect(deps.finishBlockRun).toHaveBeenCalledWith(
      deps.prisma,
      'run-1',
      expect.any(Date),
      'failed',
    )
  })

  it('failedCount > 0 だが完走した場合 BlockRun.status は partial になる', async () => {
    const config: BlockerAppConfig = {
      accounts: [
        {
          email: 'a@example.com',
          username: 'alice',
          password: 'p',
          otpSecret: null,
          blockEnabled: true,
          blockRule: { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
        },
      ],
      discordWebhookUrl: null,
    }
    const runBlockAccountCycle = vi
      .fn()
      .mockResolvedValue({ username: 'alice', blockedCount: 1, failedCount: 1, failed: false })
    const deps = {
      config,
      startOrResumeBlockRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
      finishBlockRun: vi.fn().mockResolvedValue(undefined),
      touchBlockRunHeartbeat: vi.fn().mockResolvedValue(undefined),
      runBlockAccountCycle,
      notifyDiscord: vi.fn().mockResolvedValue(undefined),
      reconcileAccountOutbox: vi.fn().mockResolvedValue(undefined),
      prisma: {},
    }

    await runBlockCycle(deps as never)

    expect(deps.finishBlockRun).toHaveBeenCalledWith(
      deps.prisma,
      'run-1',
      expect.any(Date),
      'partial',
    )
  })

  it('reconcileAccountOutbox が失敗しても他アカウントの reconciliation と run 自体は継続する', async () => {
    const config: BlockerAppConfig = {
      accounts: [
        {
          email: 'a@example.com',
          username: 'alice',
          password: 'p',
          otpSecret: null,
          blockEnabled: true,
          blockRule: { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
        },
        {
          email: 'c@example.com',
          username: 'carol',
          password: 'p',
          otpSecret: null,
          blockEnabled: true,
          blockRule: { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
        },
      ],
      discordWebhookUrl: null,
    }
    const runBlockAccountCycle = vi
      .fn()
      .mockResolvedValue({ username: 'alice', blockedCount: 0, failedCount: 0, failed: false })
    const reconcileAccountOutbox = vi
      .fn()
      .mockRejectedValueOnce(new Error('cookie issuer down'))
      .mockResolvedValueOnce(undefined)
    const deps = {
      config,
      startOrResumeBlockRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
      finishBlockRun: vi.fn().mockResolvedValue(undefined),
      touchBlockRunHeartbeat: vi.fn().mockResolvedValue(undefined),
      runBlockAccountCycle,
      notifyDiscord: vi.fn().mockResolvedValue(undefined),
      reconcileAccountOutbox,
      prisma: {},
    }

    await runBlockCycle(deps as never)

    expect(reconcileAccountOutbox).toHaveBeenCalledTimes(2)
  })

  it('block本処理が成功した場合、reconciliationはcookiesを再利用しCookie Issuerへ追加request しない', async () => {
    const config: BlockerAppConfig = {
      accounts: [
        {
          email: 'a@example.com',
          username: 'alice',
          password: 'p',
          otpSecret: null,
          blockEnabled: true,
          blockRule: { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
        },
      ],
      discordWebhookUrl: null,
    }
    const issuedCookies = { ct0: 'c0', authToken: 'a0' }
    issueCookiesWithRetry.mockResolvedValue(issuedCookies)
    const runBlockAccountCycle = vi
      .fn()
      .mockImplementation(
        async (accountDeps: { issueCookies: (a: unknown) => Promise<unknown> }) => {
          await accountDeps.issueCookies({
            username: 'alice',
            password: 'p',
            otp_secret: null,
          })
          return { username: 'alice', blockedCount: 0, failedCount: 0, failed: false }
        },
      )
    const reconcileAccountOutbox = vi.fn().mockResolvedValue(undefined)
    const deps = {
      config,
      startOrResumeBlockRun: vi.fn().mockResolvedValue({ id: 'run-1', completedUsernames: [] }),
      finishBlockRun: vi.fn().mockResolvedValue(undefined),
      touchBlockRunHeartbeat: vi.fn().mockResolvedValue(undefined),
      runBlockAccountCycle,
      notifyDiscord: vi.fn().mockResolvedValue(undefined),
      reconcileAccountOutbox,
      prisma: {},
    }

    await runBlockCycle(deps as never)

    expect(issueCookiesWithRetry).toHaveBeenCalledTimes(1)
    expect(reconcileAccountOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'alice' }),
      deps.prisma,
      issuedCookies,
    )
  })

  it('block本処理の認証自体が失敗した場合、reconciliationはcookies無しで呼ばれる (自前で再発行するフォールバック)', async () => {
    const config: BlockerAppConfig = {
      accounts: [
        {
          email: 'a@example.com',
          username: 'alice',
          password: 'p',
          otpSecret: null,
          blockEnabled: true,
          blockRule: { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
        },
      ],
      discordWebhookUrl: null,
    }
    // issueCookies を呼ばずに失敗するケース (認証以前の失敗を再現)
    const runBlockAccountCycle = vi
      .fn()
      .mockResolvedValue({ username: 'alice', blockedCount: 0, failedCount: 0, failed: true })
    const reconcileAccountOutbox = vi.fn().mockResolvedValue(undefined)
    const deps = {
      config,
      startOrResumeBlockRun: vi.fn().mockResolvedValue({ id: 'run-1', completedUsernames: [] }),
      finishBlockRun: vi.fn().mockResolvedValue(undefined),
      touchBlockRunHeartbeat: vi.fn().mockResolvedValue(undefined),
      runBlockAccountCycle,
      notifyDiscord: vi.fn().mockResolvedValue(undefined),
      reconcileAccountOutbox,
      prisma: {},
    }

    await runBlockCycle(deps as never)

    expect(reconcileAccountOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'alice' }),
      deps.prisma,
      undefined,
    )
  })
})
