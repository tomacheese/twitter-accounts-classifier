import { describe, expect, it, vi } from 'vitest'
import { runBlockAccountCycle } from './block-cycle'
import type { BlockerAccountConfig } from './config/load-config'

function baseAccount(): Extract<BlockerAccountConfig, { blockEnabled: true }> {
  return {
    email: 'a@example.com',
    username: 'alice',
    password: 'p',
    otpSecret: null,
    blockEnabled: true,
    blockRule: { targetLabels: ['spam'], confidenceThreshold: 0.8 },
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
      { targetLabels: ['spam'], confidenceThreshold: 0.8 },
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
    expect(deps.recordSuccessfulBlock).toHaveBeenCalledWith(deps.prisma, 'blocker-1', 'spam-1')
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
