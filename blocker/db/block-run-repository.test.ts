import { describe, expect, it, vi } from 'vitest'
import {
  startBlockRun,
  finishBlockRun,
  touchBlockRunHeartbeat,
  startBlockAccountRun,
  finishBlockAccountRun,
  recordBlockAction,
  hasSuccessfulBlockAction,
} from './block-run-repository'

function fakePrisma() {
  return {
    blockRun: {
      create: vi.fn().mockResolvedValue({ id: 'run-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    blockAccountRun: {
      create: vi.fn().mockResolvedValue({ id: 'account-run-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    blockAction: {
      create: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
  }
}

describe('startBlockRun', () => {
  it('creates a running BlockRun row with the given startedAt as the heartbeat', async () => {
    const prisma = fakePrisma()
    const startedAt = new Date('2026-08-04T00:00:00Z')

    const result = await startBlockRun(prisma as never, startedAt)

    expect(result.id).toBe('run-1')
    expect(prisma.blockRun.create).toHaveBeenCalledWith({
      data: { startedAt, lastHeartbeatAt: startedAt, status: 'running' },
    })
  })
})

describe('finishBlockRun', () => {
  it('sets finishedAt and status', async () => {
    const prisma = fakePrisma()
    const finishedAt = new Date('2026-08-04T01:00:00Z')

    await finishBlockRun(prisma as never, 'run-1', finishedAt, 'completed')

    expect(prisma.blockRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { finishedAt, status: 'completed' },
    })
  })
})

describe('touchBlockRunHeartbeat', () => {
  it('updates lastHeartbeatAt', async () => {
    const prisma = fakePrisma()
    const at = new Date('2026-08-04T00:30:00Z')

    await touchBlockRunHeartbeat(prisma as never, 'run-1', at)

    expect(prisma.blockRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { lastHeartbeatAt: at },
    })
  })
})

describe('startBlockAccountRun', () => {
  it('creates a running BlockAccountRun row', async () => {
    const prisma = fakePrisma()
    const startedAt = new Date('2026-08-04T00:00:00Z')

    const result = await startBlockAccountRun(prisma as never, {
      blockRunId: 'run-1',
      username: 'alice',
      startedAt,
    })

    expect(result.id).toBe('account-run-1')
    expect(prisma.blockAccountRun.create).toHaveBeenCalledWith({
      data: { blockRunId: 'run-1', username: 'alice', startedAt, status: 'running' },
    })
  })
})

describe('finishBlockAccountRun', () => {
  it('records counts and status', async () => {
    const prisma = fakePrisma()
    const finishedAt = new Date('2026-08-04T00:10:00Z')

    await finishBlockAccountRun(prisma as never, 'account-run-1', {
      finishedAt,
      status: 'completed',
      candidatesCount: 3,
      blockedCount: 2,
      failedCount: 1,
      errorMessage: null,
    })

    expect(prisma.blockAccountRun.update).toHaveBeenCalledWith({
      where: { id: 'account-run-1' },
      data: {
        finishedAt,
        status: 'completed',
        candidatesCount: 3,
        blockedCount: 2,
        failedCount: 1,
        errorMessage: null,
      },
    })
  })
})

describe('recordBlockAction', () => {
  it('creates a BlockAction row for a single attempt', async () => {
    const prisma = fakePrisma()

    await recordBlockAction(prisma as never, {
      blockAccountRunId: 'account-run-1',
      blockerId: 'blocker-1',
      blockedId: 'blocked-1',
      labelDefinitionId: 'label-1',
      confidence: 0.95,
      result: 'success',
      errorMessage: null,
    })

    expect(prisma.blockAction.create).toHaveBeenCalledWith({
      data: {
        blockAccountRunId: 'account-run-1',
        blockerId: 'blocker-1',
        blockedId: 'blocked-1',
        labelDefinitionId: 'label-1',
        confidence: 0.95,
        result: 'success',
        errorMessage: null,
      },
    })
  })
})

describe('hasSuccessfulBlockAction', () => {
  it('returns false when no successful attempt exists', async () => {
    const prisma = fakePrisma()

    const result = await hasSuccessfulBlockAction(prisma as never, 'blocker-1', 'blocked-1')

    expect(result).toBe(false)
    expect(prisma.blockAction.count).toHaveBeenCalledWith({
      where: { blockerId: 'blocker-1', blockedId: 'blocked-1', result: 'success' },
    })
  })

  it('returns true when a successful attempt exists', async () => {
    const prisma = fakePrisma()
    prisma.blockAction.count.mockResolvedValue(1)

    const result = await hasSuccessfulBlockAction(prisma as never, 'blocker-1', 'blocked-1')

    expect(result).toBe(true)
  })
})
