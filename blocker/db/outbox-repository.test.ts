import { describe, expect, it, vi } from 'vitest'
import {
  findOrCreateOutboxEntry,
  markOutboxRemoteSucceeded,
  markOutboxLocalPersisted,
  markOutboxRemoteFailed,
  findStalledOutboxEntries,
  hasBlockRow,
  hasBlockAction,
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
      count: vi.fn().mockResolvedValue(0),
    },
    blockAction: {
      count: vi.fn().mockResolvedValue(0),
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
      blockAccountRunId: 'bar-1',
      blockerId: 'blocker-1',
      blockedId: 'blocked-1',
      labelDefinitionId: 'label-1',
      confidence: 0.9,
    })

    expect(result).toEqual({ id: 'outbox-old', status: 'pending_remote' })
    expect(prisma.blockOutboxEntry.update).toHaveBeenCalledWith({
      where: { id: 'outbox-old' },
      data: { status: 'pending_remote', remoteSucceededAt: null, localPersistedAt: null },
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

describe('hasBlockRow', () => {
  it('Block 行が存在すれば true を返す', async () => {
    const prisma = createMockPrismaClient()
    vi.mocked(prisma.block.count).mockResolvedValue(1)

    const result = await hasBlockRow(prisma as never, 'blocker-1', 'blocked-1')

    expect(result).toBe(true)
  })
})

describe('hasBlockAction', () => {
  it('BlockAction 行が存在すれば true を返す', async () => {
    const prisma = createMockPrismaClient()
    vi.mocked(prisma.blockAction.count).mockResolvedValue(1)

    const result = await hasBlockAction(prisma as never, 'outbox-1')

    expect(result).toBe(true)
  })
})
