import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import {
  applyUpstreamBlocking,
  deriveCycleStatus,
  deriveWorkItemStage,
  type WorkItemStage,
} from './cycle-common'

/**
 * @returns analysisWorkItem.findUnique を差し替え可能な Prisma クライアントのモックと、
 * その差し替え用の関数
 */
function createMockPrismaClient(): {
  prisma: PrismaClient
  findUnique: ReturnType<typeof vi.fn>
} {
  const findUnique = vi.fn()
  return {
    prisma: { analysisWorkItem: { findUnique } } as unknown as PrismaClient,
    findUnique,
  }
}

describe('deriveCycleStatus', () => {
  it('4 Stage すべて succeeded なら succeeded を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'succeeded', 'succeeded', 'succeeded'])).toBe(
      'succeeded',
    )
  })

  it('起点 Stage が succeeded で後続に failed があれば partial を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'failed', 'succeeded', 'succeeded'])).toBe('partial')
  })

  it('起点 Stage 自体が failed なら failed を返す', () => {
    expect(deriveCycleStatus(['failed', 'waiting', 'waiting', 'waiting'])).toBe('failed')
  })

  it('failed が無く running があれば running を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'running', 'waiting'])).toBe('running')
  })

  it('未着手の Stage だけが残っていれば scheduled を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'waiting', 'waiting'])).toBe('scheduled')
  })

  it('起点 Stage が succeeded で後続に skipped があれば partial を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'succeeded', 'succeeded', 'skipped'])).toBe('partial')
  })

  it('起点 Stage 自体が failed で後続が skipped なら failed を返す', () => {
    expect(deriveCycleStatus(['failed', 'skipped', 'skipped', 'skipped'])).toBe('failed')
  })

  it('起点 Stage が partial なら Cycle 全体も partial を返す', () => {
    expect(deriveCycleStatus(['partial', 'succeeded', 'succeeded'])).toBe('partial')
  })

  it('起点 Stage が failed なら後続に partial があっても failed を返す', () => {
    expect(deriveCycleStatus(['failed', 'partial'])).toBe('failed')
  })

  it('blocked_by_upstream を含む場合 partial を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'blocked_by_upstream'])).toBe('partial')
  })
})

describe('deriveWorkItemStage', () => {
  it('WorkItem が存在しない場合 workItemExists: false を返す', async () => {
    const { prisma, findUnique } = createMockPrismaClient()
    findUnique.mockResolvedValue(null)

    const stage = await deriveWorkItemStage(prisma, 'label_aggregate_refresh', 'crawl_run', 'run-1')

    expect(stage.workItemExists).toBe(false)
    expect(stage.status).toBe('failed')
  })

  it('WorkItem が存在する場合 workItemExists: true を返す', async () => {
    const { prisma, findUnique } = createMockPrismaClient()
    findUnique.mockResolvedValue({
      status: 'succeeded',
      attemptCount: 1,
      lastErrorCode: null,
      lastErrorSummary: null,
      runs: [],
    } as never)

    const stage = await deriveWorkItemStage(prisma, 'label_aggregate_refresh', 'crawl_run', 'run-1')

    expect(stage.workItemExists).toBe(true)
  })
})

describe('applyUpstreamBlocking', () => {
  it('WorkItem が存在せず直前 Stage が succeeded 以外なら blocked_by_upstream にする', () => {
    const stage: WorkItemStage = {
      status: 'failed',
      attemptCount: 0,
      errorCode: undefined,
      errorSummary: 'work item was never enqueued',
      analysisRunId: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      workItemExists: false,
    }
    const result = applyUpstreamBlocking(stage, 'failed')
    expect(result.status).toBe('blocked_by_upstream')
  })

  it('WorkItem が存在しない場合でも直前 Stage が succeeded なら変更しない', () => {
    const stage: WorkItemStage = {
      status: 'failed',
      attemptCount: 0,
      errorCode: undefined,
      errorSummary: 'work item was never enqueued',
      analysisRunId: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      workItemExists: false,
    }
    const result = applyUpstreamBlocking(stage, 'succeeded')
    expect(result.status).toBe('failed')
  })

  it('WorkItem が存在する場合は変更しない', () => {
    const stage: WorkItemStage = {
      status: 'succeeded',
      attemptCount: 1,
      errorCode: undefined,
      errorSummary: undefined,
      analysisRunId: 'run-1',
      startedAt: new Date(),
      finishedAt: new Date(),
      workItemExists: true,
    }
    const result = applyUpstreamBlocking(stage, 'failed')
    expect(result.status).toBe('succeeded')
  })

  it('WorkItem が存在せず直前 Stage が running なら waiting にする', () => {
    const stage: WorkItemStage = {
      status: 'failed',
      attemptCount: 0,
      errorCode: undefined,
      errorSummary: 'work item was never enqueued',
      analysisRunId: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      workItemExists: false,
    }
    const result = applyUpstreamBlocking(stage, 'running')
    expect(result.status).toBe('waiting')
  })

  it('WorkItem が存在せず直前 Stage が waiting なら waiting を連鎖させる', () => {
    const stage: WorkItemStage = {
      status: 'failed',
      attemptCount: 0,
      errorCode: undefined,
      errorSummary: 'work item was never enqueued',
      analysisRunId: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      workItemExists: false,
    }
    const result = applyUpstreamBlocking(stage, 'waiting')
    expect(result.status).toBe('waiting')
  })
})
