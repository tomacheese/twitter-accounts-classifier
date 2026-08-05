import { describe, expect, it, vi } from 'vitest'
import {
  startOrResumeBlockRun,
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
      findFirst: vi.fn().mockResolvedValue(null),
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

describe('startOrResumeBlockRun', () => {
  it('creates a running BlockRun row when none is currently running', async () => {
    const prisma = fakePrisma()
    const startedAt = new Date('2026-08-04T00:00:00Z')

    const result = await startOrResumeBlockRun(prisma as never, startedAt, 3_600_000)

    expect(result.id).toBe('run-1')
    expect(prisma.blockRun.create).toHaveBeenCalledWith({
      data: {
        startedAt,
        lastHeartbeatAt: startedAt,
        status: 'running',
        staleAfterAt: new Date(startedAt.getTime() + 3_600_000),
      },
    })
  })

  it('resumes the existing running BlockRun when its heartbeat is not stale', async () => {
    const prisma = fakePrisma()
    const startedAt = new Date('2026-08-04T00:00:00Z')
    prisma.blockRun.findFirst.mockResolvedValue({
      id: 'existing-run',
      lastHeartbeatAt: new Date('2026-08-03T23:59:00Z'),
    })

    const result = await startOrResumeBlockRun(prisma as never, startedAt, 3_600_000)

    expect(result.id).toBe('existing-run')
    expect(prisma.blockRun.create).not.toHaveBeenCalled()
  })

  it('finalizes a stale running BlockRun as failed and creates a new one', async () => {
    const prisma = fakePrisma()
    const startedAt = new Date('2026-08-04T00:00:00Z')
    const staleHeartbeat = new Date('2026-08-03T00:00:00Z')
    prisma.blockRun.findFirst.mockResolvedValue({
      id: 'stale-run',
      lastHeartbeatAt: staleHeartbeat,
    })

    const result = await startOrResumeBlockRun(prisma as never, startedAt, 3_600_000)

    expect(prisma.blockRun.update).toHaveBeenCalledWith({
      where: { id: 'stale-run' },
      data: { finishedAt: staleHeartbeat, status: 'failed' },
    })
    expect(prisma.blockRun.create).toHaveBeenCalledWith({
      data: {
        startedAt,
        lastHeartbeatAt: startedAt,
        status: 'running',
        staleAfterAt: new Date(startedAt.getTime() + 3_600_000),
      },
    })
    expect(result.id).toBe('run-1')
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
  it('updates lastHeartbeatAt and staleAfterAt', async () => {
    const prisma = fakePrisma()
    const at = new Date('2026-08-04T00:30:00Z')

    await touchBlockRunHeartbeat(prisma as never, 'run-1', at, 3_600_000)

    expect(prisma.blockRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { lastHeartbeatAt: at, staleAfterAt: new Date('2026-08-04T01:30:00Z') },
    })
  })

  it('updates lastHeartbeatAt and staleAfterAt from the given time and threshold', async () => {
    const prisma = fakePrisma()
    const at = new Date('2026-08-05T00:00:00Z')

    await touchBlockRunHeartbeat(prisma as never, 'run-1', at, 3_600_000)

    expect(prisma.blockRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { lastHeartbeatAt: at, staleAfterAt: new Date('2026-08-05T01:00:00Z') },
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
