import { describe, expect, it, vi } from 'vitest'
import { reconcileOutboxEntries } from './reconciliation'

function createMockDeps() {
  return {
    prisma: {},
    blockerId: 'blocker-1',
    client: {},
    findStalledOutboxEntries: vi.fn().mockResolvedValue([]),
    findExistingBlockedIds: vi.fn().mockResolvedValue(new Set()),
    findOutboxEntryIdsWithBlockAction: vi.fn().mockResolvedValue(new Set()),
    recordSuccessfulBlock: vi.fn().mockResolvedValue(undefined),
    recordBlockAction: vi.fn().mockResolvedValue(undefined),
    markOutboxRemoteSucceeded: vi.fn().mockResolvedValue(undefined),
    markOutboxLocalPersisted: vi.fn().mockResolvedValue(undefined),
    markOutboxRemoteFailed: vi.fn().mockResolvedValue(undefined),
    fetchRemotelyBlockedIds: vi.fn().mockResolvedValue(new Set()),
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
    vi.mocked(deps.findExistingBlockedIds).mockResolvedValue(new Set())
    vi.mocked(deps.findOutboxEntryIdsWithBlockAction).mockResolvedValue(new Set())

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
    vi.mocked(deps.findExistingBlockedIds).mockResolvedValue(new Set(['blocked-1']))
    vi.mocked(deps.findOutboxEntryIdsWithBlockAction).mockResolvedValue(new Set(['outbox-1']))

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
    vi.mocked(deps.fetchRemotelyBlockedIds).mockResolvedValue(new Set())

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
    vi.mocked(deps.fetchRemotelyBlockedIds).mockResolvedValue(new Set(['blocked-3']))

    await reconcileOutboxEntries(deps as never, deps.prisma as never)

    expect(deps.markOutboxRemoteSucceeded).toHaveBeenCalledWith(deps.prisma, 'outbox-3', true)
  })

  it('停滞 entry が複数あれば順に処理し、remote 確認は entry ごとではなく 1 回にまとめる', async () => {
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
    expect(deps.fetchRemotelyBlockedIds).toHaveBeenCalledTimes(1)
    expect(deps.fetchRemotelyBlockedIds).toHaveBeenCalledWith(deps.client)
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
    vi.mocked(deps.recordSuccessfulBlock).mockRejectedValueOnce(new Error('db down'))

    await reconcileOutboxEntries(deps as never, deps.prisma as never)

    expect(deps.markOutboxLocalPersisted).toHaveBeenCalledTimes(1)
    expect(deps.markOutboxLocalPersisted).toHaveBeenCalledWith(deps.prisma, 'outbox-2', true)
  })
})
