import { describe, expect, it, vi } from 'vitest'
import {
  findOrCreateOutboxEntry,
  markOutboxRemoteSucceeded,
  markOutboxLocalPersisted,
  markOutboxRemoteFailed,
  findStalledOutboxEntries,
  findExistingBlockedIds,
  findOutboxEntryIdsWithBlockAction,
} from './outbox-repository'

function createMockPrismaClient() {
  return {
    blockOutboxEntry: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    block: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    blockAction: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  }
}

describe('findOrCreateOutboxEntry', () => {
  it('既存の未解決 entry があれば再利用する', async () => {
    const prisma = createMockPrismaClient()
    vi.mocked(prisma.blockOutboxEntry.findUnique).mockResolvedValue({
      id: 'outbox-1',
      status: 'pending_remote',
    } as never)

    const result = await findOrCreateOutboxEntry(prisma as never, {
      blockAccountRunId: 'bar-1',
      blockerId: 'blocker-1',
      blockedId: 'blocked-1',
      labelDefinitionId: 'label-1',
      confidence: 0.9,
    })

    expect(result).toEqual({ id: 'outbox-1', status: 'pending_remote' })
    expect(prisma.blockOutboxEntry.create).not.toHaveBeenCalled()
  })

  it('未解決 entry が無ければ pending_remote で新規作成する', async () => {
    const prisma = createMockPrismaClient()
    vi.mocked(prisma.blockOutboxEntry.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.blockOutboxEntry.create).mockResolvedValue({
      id: 'outbox-2',
      status: 'pending_remote',
    } as never)

    const result = await findOrCreateOutboxEntry(prisma as never, {
      blockAccountRunId: 'bar-1',
      blockerId: 'blocker-1',
      blockedId: 'blocked-1',
      labelDefinitionId: 'label-1',
      confidence: 0.9,
    })

    expect(result.status).toBe('pending_remote')
    expect(prisma.blockOutboxEntry.create).toHaveBeenCalled()
  })

  it('既存 entry が remote_failed など解決済みなら pending_remote に戻して再利用する', async () => {
    const prisma = createMockPrismaClient()
    vi.mocked(prisma.blockOutboxEntry.findUnique).mockResolvedValue({
      id: 'outbox-old',
      status: 'remote_failed',
    } as never)
    vi.mocked(prisma.blockOutboxEntry.update).mockResolvedValue({
      id: 'outbox-old',
      status: 'pending_remote',
    } as never)

    const result = await findOrCreateOutboxEntry(prisma as never, {
      blockAccountRunId: 'bar-2',
      blockerId: 'blocker-1',
      blockedId: 'blocked-1',
      labelDefinitionId: 'label-2',
      confidence: 0.5,
    })

    expect(result).toEqual({ id: 'outbox-old', status: 'pending_remote' })
    expect(prisma.blockOutboxEntry.update).toHaveBeenCalledWith({
      where: { id: 'outbox-old' },
      data: {
        status: 'pending_remote',
        remoteSucceededAt: null,
        localPersistedAt: null,
        blockAccountRunId: 'bar-2',
        labelDefinitionId: 'label-2',
        confidence: 0.5,
      },
    })
    expect(prisma.blockOutboxEntry.create).not.toHaveBeenCalled()
  })
})

describe('markOutboxRemoteSucceeded/markOutboxLocalPersisted/markOutboxRemoteFailed', () => {
  it('remote_succeeded に更新する', async () => {
    const prisma = createMockPrismaClient()

    await markOutboxRemoteSucceeded(prisma as never, 'outbox-1')

    expect(prisma.blockOutboxEntry.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: expect.objectContaining({ status: 'remote_succeeded' }),
    })
  })

  it('local_persisted に更新する', async () => {
    const prisma = createMockPrismaClient()

    await markOutboxLocalPersisted(prisma as never, 'outbox-1')

    expect(prisma.blockOutboxEntry.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: expect.objectContaining({ status: 'local_persisted' }),
    })
    expect(prisma.blockOutboxEntry.update).not.toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: expect.objectContaining({ reconciledAt: expect.anything() }),
    })
  })

  it('reconciled=true の場合は remote_succeeded と同時に reconciledAt も記録する', async () => {
    const prisma = createMockPrismaClient()

    await markOutboxRemoteSucceeded(prisma as never, 'outbox-1', true)

    expect(prisma.blockOutboxEntry.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: expect.objectContaining({ status: 'remote_succeeded', reconciledAt: expect.any(Date) }),
    })
  })

  it('reconciled=true の場合は local_persisted と同時に reconciledAt も記録する', async () => {
    const prisma = createMockPrismaClient()

    await markOutboxLocalPersisted(prisma as never, 'outbox-1', true)

    expect(prisma.blockOutboxEntry.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: expect.objectContaining({ status: 'local_persisted', reconciledAt: expect.any(Date) }),
    })
  })

  it('remote_failed に更新する', async () => {
    const prisma = createMockPrismaClient()

    await markOutboxRemoteFailed(prisma as never, 'outbox-1')

    expect(prisma.blockOutboxEntry.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: { status: 'remote_failed' },
    })
  })
})

describe('findStalledOutboxEntries', () => {
  it('blockerId と pending_remote/remote_succeeded を停滞判定の対象にする', async () => {
    const prisma = createMockPrismaClient()

    await findStalledOutboxEntries(prisma as never, 'blocker-1', 1000)

    expect(prisma.blockOutboxEntry.findMany).toHaveBeenCalledWith({
      where: {
        blockerId: 'blocker-1',
        status: { in: ['pending_remote', 'remote_succeeded'] },
        createdAt: { lt: expect.any(Date) },
      },
    })
  })
})

describe('findExistingBlockedIds', () => {
  it('Block 行が存在する blockedId の集合を返す', async () => {
    const prisma = createMockPrismaClient()
    vi.mocked(prisma.block.findMany).mockResolvedValue([{ blockedId: 'blocked-1' }] as never)

    const result = await findExistingBlockedIds(prisma as never, 'blocker-1', [
      'blocked-1',
      'blocked-2',
    ])

    expect(result).toEqual(new Set(['blocked-1']))
    expect(prisma.block.findMany).toHaveBeenCalledWith({
      where: { blockerId: 'blocker-1', blockedId: { in: ['blocked-1', 'blocked-2'] } },
      select: { blockedId: true },
    })
  })

  it('blockedIds が空なら query を発行せず空集合を返す', async () => {
    const prisma = createMockPrismaClient()

    const result = await findExistingBlockedIds(prisma as never, 'blocker-1', [])

    expect(result).toEqual(new Set())
    expect(prisma.block.findMany).not.toHaveBeenCalled()
  })
})

describe('findOutboxEntryIdsWithBlockAction', () => {
  it('BlockAction が存在する outboxEntryId の集合を返す', async () => {
    const prisma = createMockPrismaClient()
    vi.mocked(prisma.blockAction.findMany).mockResolvedValue([
      { outboxEntryId: 'outbox-1' },
    ] as never)

    const result = await findOutboxEntryIdsWithBlockAction(prisma as never, [
      'outbox-1',
      'outbox-2',
    ])

    expect(result).toEqual(new Set(['outbox-1']))
  })
})
