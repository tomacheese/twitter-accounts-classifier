import { describe, expect, it, vi } from 'vitest'
import { reconcileOutboxEntries } from './reconciliation'

function createMockDeps() {
  return {
    prisma: {},
    blockerId: 'blocker-1',
    client: {},
    findStalledOutboxEntries: vi.fn().mockResolvedValue([]),
    hasBlockRow: vi.fn().mockResolvedValue(false),
    hasBlockAction: vi.fn().mockResolvedValue(false),
    recordSuccessfulBlock: vi.fn().mockResolvedValue(undefined),
    recordBlockAction: vi.fn().mockResolvedValue(undefined),
    markOutboxRemoteSucceeded: vi.fn().mockResolvedValue(undefined),
    markOutboxLocalPersisted: vi.fn().mockResolvedValue(undefined),
    markOutboxRemoteFailed: vi.fn().mockResolvedValue(undefined),
    isRemotelyBlocked: vi.fn().mockResolvedValue(false),
  }
}

describe('reconcileOutboxEntries', () => {
  it('remote_succeeded のまま停滞した entry を Block/BlockAction 両方補完して local_persisted にする', async () => {
    const deps = createMockDeps()
    vi.mocked(deps.findStalledOutboxEntries).mockResolvedValue([
      {
        id: 'outbox-1',
        status: 'remote_succeeded',
        blockerId: 'blocker-1',
        blockedId: 'blocked-1',
        labelDefinitionId: 'label-1',
        confidence: 0.9,
        blockAccountRunId: 'bar-1',
      },
    ])
    vi.mocked(deps.hasBlockRow).mockResolvedValue(false)
    vi.mocked(deps.hasBlockAction).mockResolvedValue(false)

    await reconcileOutboxEntries(deps as never, deps.prisma as never)

    expect(deps.recordSuccessfulBlock).toHaveBeenCalledWith(
      deps.prisma,
      'blocker-1',
      'blocked-1',
      'bar-1',
    )
    expect(deps.recordBlockAction).toHaveBeenCalledWith(
      deps.prisma,
      expect.objectContaining({ outboxEntryId: 'outbox-1', result: 'success' }),
    )
    expect(deps.markOutboxLocalPersisted).toHaveBeenCalledWith(deps.prisma, 'outbox-1', true)
  })

  it('Block/BlockAction が既に存在する remote_succeeded entry は補完せず local_persisted にのみ進める', async () => {
    const deps = createMockDeps()
    vi.mocked(deps.findStalledOutboxEntries).mockResolvedValue([
      {
        id: 'outbox-1',
        status: 'remote_succeeded',
        blockerId: 'blocker-1',
        blockedId: 'blocked-1',
        labelDefinitionId: 'label-1',
        confidence: 0.9,
        blockAccountRunId: 'bar-1',
      },
    ])
    vi.mocked(deps.hasBlockRow).mockResolvedValue(true)
    vi.mocked(deps.hasBlockAction).mockResolvedValue(true)

    await reconcileOutboxEntries(deps as never, deps.prisma as never)

    expect(deps.recordSuccessfulBlock).not.toHaveBeenCalled()
    expect(deps.recordBlockAction).not.toHaveBeenCalled()
    expect(deps.markOutboxLocalPersisted).toHaveBeenCalledWith(deps.prisma, 'outbox-1', true)
  })

  it('pending_remote のまま停滞し実際は未実施の entry は remote_failed にして次回の再選定に委ねる', async () => {
    const deps = createMockDeps()
    vi.mocked(deps.findStalledOutboxEntries).mockResolvedValue([
      {
        id: 'outbox-2',
        status: 'pending_remote',
        blockerId: 'blocker-1',
        blockedId: 'blocked-2',
        labelDefinitionId: 'label-1',
        confidence: 0.9,
        blockAccountRunId: 'bar-1',
      },
    ])
    vi.mocked(deps.isRemotelyBlocked).mockResolvedValue(false)

    await reconcileOutboxEntries(deps as never, deps.prisma as never)

    expect(deps.markOutboxRemoteSucceeded).not.toHaveBeenCalled()
    expect(deps.markOutboxLocalPersisted).not.toHaveBeenCalled()
    expect(deps.markOutboxRemoteFailed).toHaveBeenCalledWith(deps.prisma, 'outbox-2')
  })

  it('pending_remote のまま停滞し実際は remote 成功済みの entry は remote_succeeded へ進める', async () => {
    const deps = createMockDeps()
    vi.mocked(deps.findStalledOutboxEntries).mockResolvedValue([
      {
        id: 'outbox-3',
        status: 'pending_remote',
        blockerId: 'blocker-1',
        blockedId: 'blocked-3',
        labelDefinitionId: 'label-1',
        confidence: 0.9,
        blockAccountRunId: 'bar-1',
      },
    ])
    vi.mocked(deps.isRemotelyBlocked).mockResolvedValue(true)

    await reconcileOutboxEntries(deps as never, deps.prisma as never)

    expect(deps.markOutboxRemoteSucceeded).toHaveBeenCalledWith(deps.prisma, 'outbox-3', true)
  })

  it('停滞 entry が複数あれば順に処理する', async () => {
    const deps = createMockDeps()
    vi.mocked(deps.findStalledOutboxEntries).mockResolvedValue([
      {
        id: 'outbox-1',
        status: 'remote_succeeded',
        blockerId: 'blocker-1',
        blockedId: 'blocked-1',
        labelDefinitionId: 'label-1',
        confidence: 0.9,
        blockAccountRunId: 'bar-1',
      },
      {
        id: 'outbox-2',
        status: 'pending_remote',
        blockerId: 'blocker-1',
        blockedId: 'blocked-2',
        labelDefinitionId: 'label-1',
        confidence: 0.9,
        blockAccountRunId: 'bar-1',
      },
    ])

    await reconcileOutboxEntries(deps as never, deps.prisma as never)

    expect(deps.markOutboxLocalPersisted).toHaveBeenCalledWith(deps.prisma, 'outbox-1', true)
    expect(deps.isRemotelyBlocked).toHaveBeenCalledWith(deps.client, 'blocked-2')
  })

  it('1件の entry の reconciliation が失敗しても残りの entry は処理する', async () => {
    const deps = createMockDeps()
    vi.mocked(deps.findStalledOutboxEntries).mockResolvedValue([
      {
        id: 'outbox-1',
        status: 'remote_succeeded',
        blockerId: 'blocker-1',
        blockedId: 'blocked-1',
        labelDefinitionId: 'label-1',
        confidence: 0.9,
        blockAccountRunId: 'bar-1',
      },
      {
        id: 'outbox-2',
        status: 'remote_succeeded',
        blockerId: 'blocker-1',
        blockedId: 'blocked-2',
        labelDefinitionId: 'label-1',
        confidence: 0.9,
        blockAccountRunId: 'bar-1',
      },
    ])
    vi.mocked(deps.hasBlockRow).mockRejectedValueOnce(new Error('db down')).mockResolvedValue(false)

    await reconcileOutboxEntries(deps as never, deps.prisma as never)

    expect(deps.markOutboxLocalPersisted).toHaveBeenCalledTimes(1)
    expect(deps.markOutboxLocalPersisted).toHaveBeenCalledWith(deps.prisma, 'outbox-2', true)
  })
})
