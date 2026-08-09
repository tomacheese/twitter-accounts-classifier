import { describe, expect, it, vi } from 'vitest'
import { runBlockAccountCycle, attemptBlock } from './block-cycle'
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
  const client = {
    client: {
      getUserApi: vi.fn().mockReturnValue({
        getUserByScreenName: vi.fn().mockResolvedValue({ data: { user: { restId: 'blocker-1' } } }),
      }),
    },
    createBlock: vi.fn().mockResolvedValue(undefined),
  }
  return {
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
    prisma: {},
    limits: { intervalSeconds: 21_600, actionDelayMs: 0, maxPerAccountPerRun: 50 },
    sleepImpl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('runBlockAccountCycle', () => {
  it('resolves the own account id via getUserByScreenName before selecting candidates', async () => {
    const deps = fakeDeps()

    await runBlockAccountCycle(deps as never, baseAccount(), 'run-1')

    expect(deps.selectBlockCandidates).toHaveBeenCalledWith(
      deps.prisma,
      'blocker-1',
      { targetLabels: [{ label: 'spam', confidenceThreshold: 0.8 }] },
      50,
    )
  })

  it('blocks each candidate sequentially and records success/failure independently', async () => {
    const candidates = [
      { accountId: 'spam-1', labelDefinitionId: 'label-spam', confidence: 0.95 },
      { accountId: 'spam-2', labelDefinitionId: 'label-spam', confidence: 0.9 },
    ]
    const client = {
      client: {
        getUserApi: vi.fn().mockReturnValue({
          getUserByScreenName: vi
            .fn()
            .mockResolvedValue({ data: { user: { restId: 'blocker-1' } } }),
        }),
      },
      createBlock: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('rate limited')),
    }
    const deps = fakeDeps({
      createOpenApiClient: vi.fn().mockResolvedValue(client),
      selectBlockCandidates: vi.fn().mockResolvedValue(candidates),
    })

    const summary = await runBlockAccountCycle(deps as never, baseAccount(), 'run-1')

    expect(client.createBlock).toHaveBeenNthCalledWith(1, 'spam-1')
    expect(client.createBlock).toHaveBeenNthCalledWith(2, 'spam-2')
    expect(deps.recordSuccessfulBlock).toHaveBeenCalledWith(
      deps.prisma,
      'blocker-1',
      'spam-1',
      'account-run-1',
    )
    expect(deps.recordSuccessfulBlock).toHaveBeenCalledTimes(1)
    expect(deps.recordBlockAction).toHaveBeenCalledWith(
      deps.prisma,
      expect.objectContaining({ blockedId: 'spam-1', result: 'success' }),
    )
    expect(deps.recordBlockAction).toHaveBeenCalledWith(
      deps.prisma,
      expect.objectContaining({ blockedId: 'spam-2', result: 'failure' }),
    )
    expect(summary).toEqual({ username: 'alice', blockedCount: 1, failedCount: 1, failed: false })
  })

  it('waits actionDelayMs between block attempts', async () => {
    const candidates = [
      { accountId: 'spam-1', labelDefinitionId: 'label-spam', confidence: 0.95 },
      { accountId: 'spam-2', labelDefinitionId: 'label-spam', confidence: 0.9 },
    ]
    const deps = fakeDeps({
      selectBlockCandidates: vi.fn().mockResolvedValue(candidates),
      limits: { intervalSeconds: 21_600, actionDelayMs: 2000, maxPerAccountPerRun: 50 },
    })

    await runBlockAccountCycle(deps as never, baseAccount(), 'run-1')

    expect(deps.sleepImpl).toHaveBeenCalledWith(2000)
  })

  it('returns a failed summary and skips candidate selection when own account resolution fails', async () => {
    const client = {
      client: {
        getUserApi: vi.fn().mockReturnValue({
          getUserByScreenName: vi.fn().mockRejectedValue(new Error('not found')),
        }),
      },
      createBlock: vi.fn(),
    }
    const deps = fakeDeps({ createOpenApiClient: vi.fn().mockResolvedValue(client) })

    const summary = await runBlockAccountCycle(deps as never, baseAccount(), 'run-1')

    expect(deps.selectBlockCandidates).not.toHaveBeenCalled()
    expect(summary).toEqual({ username: 'alice', blockedCount: 0, failedCount: 0, failed: true })
  })
})

describe('attemptBlock', () => {
  it('createBlock 実行前に outbox entry を pending_remote で作成する', async () => {
    const deps = fakeDeps()
    const callOrder: string[] = []
    vi.mocked(deps.findOrCreateOutboxEntry).mockImplementation(async () => {
      callOrder.push('outbox_created')
      return { id: 'outbox-1', status: 'pending_remote' }
    })
    const client = createMockClient()
    vi.mocked(client.createBlock).mockImplementation(async () => {
      callOrder.push('remote_block_called')
    })

    await attemptBlock(client as never, deps as never, 'bar-1', 'blocker-1', {
      accountId: 'blocked-1',
      labelDefinitionId: 'label-1',
      confidence: 0.9,
    })

    expect(callOrder).toEqual(['outbox_created', 'remote_block_called'])
  })

  it('createBlock 失敗時は outbox entry を remote_failed にする', async () => {
    const deps = fakeDeps()
    vi.mocked(deps.findOrCreateOutboxEntry).mockResolvedValue({
      id: 'outbox-1',
      status: 'pending_remote',
    })
    const client = createMockClient()
    vi.mocked(client.createBlock).mockRejectedValue(new Error('boom'))

    await attemptBlock(client as never, deps as never, 'bar-1', 'blocker-1', {
      accountId: 'blocked-1',
      labelDefinitionId: 'label-1',
      confidence: 0.9,
    })

    expect(deps.markOutboxRemoteFailed).toHaveBeenCalledWith(deps.prisma, 'outbox-1')
  })

  it('createBlock 成功時は outbox entry を remote_succeeded → local_persisted の順に進める', async () => {
    const deps = fakeDeps()
    vi.mocked(deps.findOrCreateOutboxEntry).mockResolvedValue({
      id: 'outbox-1',
      status: 'pending_remote',
    })
    const client = createMockClient()

    const succeeded = await attemptBlock(client as never, deps as never, 'bar-1', 'blocker-1', {
      accountId: 'blocked-1',
      labelDefinitionId: 'label-1',
      confidence: 0.9,
    })

    expect(succeeded).toBe(true)
    expect(deps.markOutboxRemoteSucceeded).toHaveBeenCalledWith(deps.prisma, 'outbox-1')
    expect(deps.recordBlockAction).toHaveBeenCalledWith(
      deps.prisma,
      expect.objectContaining({ outboxEntryId: 'outbox-1', result: 'success' }),
    )
    expect(deps.markOutboxLocalPersisted).toHaveBeenCalledWith(deps.prisma, 'outbox-1')
  })
})
