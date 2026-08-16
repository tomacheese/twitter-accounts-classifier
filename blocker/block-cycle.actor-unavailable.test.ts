import { describe, expect, it, vi } from 'vitest'
import { BlockActorUnavailableError } from 'twitter-client'
import { attemptBlock, runBlockAccountCycle } from './block-cycle'
import type { BlockerAccountConfig } from './config/load-config'

function createMockClient() {
  return {
    client: {
      getUserApi: vi.fn().mockReturnValue({
        getUserByScreenName: vi.fn().mockResolvedValue({ data: { user: { restId: 'blocker-1' } } }),
      }),
    },
    createBlock: vi.fn().mockResolvedValue(undefined),
  }
}

function baseAccount(): Extract<BlockerAccountConfig, { blockEnabled: true }> {
  return {
    email: 'a@example.com',
    username: 'alice',
    password: 'p',
    otpSecret: null,
    blockEnabled: true,
    blockRule: { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
  }
}

function fakeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const client = createMockClient()
  return {
    client,
    deps: {
      issueCookies: vi.fn().mockResolvedValue({ ct0: 'c0', authToken: 'a0' }),
      createOpenApiClient: vi.fn().mockResolvedValue(client),
      closeOpenApiClient: vi.fn().mockResolvedValue(undefined),
      selectBlockCandidates: vi.fn().mockResolvedValue([]),
      recordSuccessfulBlock: vi.fn().mockResolvedValue(undefined),
      startBlockAccountRun: vi.fn().mockResolvedValue({ id: 'account-run-1' }),
      finishBlockAccountRun: vi.fn().mockResolvedValue(undefined),
      recordBlockAction: vi.fn().mockResolvedValue(undefined),
      findOrCreateOutboxEntry: vi
        .fn()
        .mockResolvedValue({ id: 'outbox-1', status: 'pending_remote' }),
      markOutboxRemoteSucceeded: vi.fn().mockResolvedValue(undefined),
      markOutboxLocalPersisted: vi.fn().mockResolvedValue(undefined),
      markOutboxRemoteFailed: vi.fn().mockResolvedValue(undefined),
      markOutboxRemoteSkipped: vi.fn().mockResolvedValue(undefined),
      prisma: {},
      limits: {
        intervalSeconds: 21_600,
        actionDelayMs: 0,
        maxPerAccountPerRun: 50,
        targetNotFoundMaxAttempts: 3,
      },
      sleepImpl: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  }
}

describe('attemptBlock actor unavailable', () => {
  it('returns actor_unavailable and does not mark the loop to continue', async () => {
    const { client, deps } = fakeDeps()
    vi.mocked(client.createBlock).mockRejectedValue(new BlockActorUnavailableError(403, 64))

    const result = await attemptBlock(
      client as never,
      deps as never,
      'bar-1',
      'blocker-1',
      { accountId: 'blocked-1', labelDefinitionId: 'label-1', confidence: 0.9 },
      'alice',
    )

    expect(result).toBe('actor_unavailable')
    expect(deps.markOutboxRemoteFailed).toHaveBeenCalledWith(deps.prisma, 'outbox-1')
  })

  it('returns actor_unavailable even when markOutboxRemoteFailed persistence fails', async () => {
    const { client, deps } = fakeDeps()
    vi.mocked(deps.markOutboxRemoteFailed).mockRejectedValue(new Error('db down'))
    vi.mocked(client.createBlock).mockRejectedValue(new BlockActorUnavailableError(403, 64))

    const result = await attemptBlock(
      client as never,
      deps as never,
      'bar-1',
      'blocker-1',
      { accountId: 'blocked-1', labelDefinitionId: 'label-1', confidence: 0.9 },
      'alice',
    )

    expect(result).toBe('actor_unavailable')
  })

  it('returns actor_unavailable even when recordBlockAction persistence fails', async () => {
    const { client, deps } = fakeDeps()
    vi.mocked(deps.recordBlockAction).mockRejectedValue(new Error('db down'))
    vi.mocked(client.createBlock).mockRejectedValue(new BlockActorUnavailableError(403, 64))

    const result = await attemptBlock(
      client as never,
      deps as never,
      'bar-1',
      'blocker-1',
      { accountId: 'blocked-1', labelDefinitionId: 'label-1', confidence: 0.9 },
      'alice',
    )

    expect(result).toBe('actor_unavailable')
  })
})

describe('runBlockAccountCycle actor unavailable', () => {
  it('stops calling createBlock after the first actor_unavailable candidate', async () => {
    const { client, deps } = fakeDeps()
    const candidates = [
      { accountId: 'blocked-1', labelDefinitionId: 'label-1', confidence: 0.9 },
      { accountId: 'blocked-2', labelDefinitionId: 'label-1', confidence: 0.9 },
      { accountId: 'blocked-3', labelDefinitionId: 'label-1', confidence: 0.9 },
    ]
    vi.mocked(deps.selectBlockCandidates).mockResolvedValue(candidates)
    vi.mocked(client.createBlock).mockRejectedValue(new BlockActorUnavailableError(403, 64))

    const summary = await runBlockAccountCycle(deps as never, baseAccount(), 'run-1')

    expect(client.createBlock).toHaveBeenCalledTimes(1)
    expect(summary).toEqual({ username: 'alice', blockedCount: 0, failedCount: 1, failed: true })
    expect(deps.finishBlockAccountRun).toHaveBeenCalledWith(
      deps.prisma,
      'account-run-1',
      expect.objectContaining({
        status: 'failed',
        candidatesCount: 3,
        blockedCount: 0,
        failedCount: 1,
        errorMessage: expect.stringContaining('Block actor account is unavailable'),
      }),
    )
  })

  it('counts prior successes before stopping at actor_unavailable', async () => {
    const { client, deps } = fakeDeps()
    const candidates = [
      { accountId: 'blocked-1', labelDefinitionId: 'label-1', confidence: 0.9 },
      { accountId: 'blocked-2', labelDefinitionId: 'label-1', confidence: 0.9 },
    ]
    vi.mocked(deps.selectBlockCandidates).mockResolvedValue(candidates)
    vi.mocked(client.createBlock)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BlockActorUnavailableError(403, 64))

    const summary = await runBlockAccountCycle(deps as never, baseAccount(), 'run-1')

    expect(client.createBlock).toHaveBeenCalledTimes(2)
    expect(summary).toEqual({ username: 'alice', blockedCount: 1, failedCount: 1, failed: true })
  })
})
