import { describe, expect, it, vi } from 'vitest'
import { BlockTargetNotFoundError } from 'twitter-client'
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

function fakeDeps() {
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
      limits: { intervalSeconds: 21_600, actionDelayMs: 0, maxPerAccountPerRun: 50 },
      sleepImpl: vi.fn().mockResolvedValue(undefined),
    },
  }
}

describe('missing block target', () => {
  it('records a missing target as skipped instead of remote_failed', async () => {
    const { client, deps } = fakeDeps()
    vi.mocked(client.createBlock).mockRejectedValue(new BlockTargetNotFoundError('blocked-1'))

    const result = await attemptBlock(client as never, deps as never, 'bar-1', 'blocker-1', {
      accountId: 'blocked-1',
      labelDefinitionId: 'label-1',
      confidence: 0.9,
    })

    expect(result).toBe('skipped')
    expect(deps.markOutboxRemoteSkipped).toHaveBeenCalledWith(deps.prisma, 'outbox-1')
    expect(deps.markOutboxRemoteFailed).not.toHaveBeenCalled()
    expect(deps.recordBlockAction).toHaveBeenCalledWith(
      deps.prisma,
      expect.objectContaining({ result: 'skipped', outboxEntryId: 'outbox-1' }),
    )
  })

  it('does not increment failedCount for a missing target', async () => {
    const { client, deps } = fakeDeps()
    const candidate = { accountId: 'missing-1', labelDefinitionId: 'label-spam', confidence: 0.95 }
    vi.mocked(client.createBlock).mockRejectedValue(
      new BlockTargetNotFoundError(candidate.accountId),
    )
    vi.mocked(deps.selectBlockCandidates).mockResolvedValue([candidate])

    const summary = await runBlockAccountCycle(deps as never, baseAccount(), 'run-1')

    expect(summary).toEqual({ username: 'alice', blockedCount: 0, failedCount: 0, failed: false })
    expect(deps.finishBlockAccountRun).toHaveBeenCalledWith(
      deps.prisma,
      'account-run-1',
      expect.objectContaining({ blockedCount: 0, failedCount: 0 }),
    )
  })
})
