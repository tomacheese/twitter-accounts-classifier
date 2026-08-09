import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import {
  enqueueWorkItem,
  claimNextWorkItem,
  deadLetterExhaustedWorkItem,
  completeWorkItem,
  renewWorkItemLease,
  computeRetryBackoffMs,
  startAnalysisRun,
  finishAnalysisRun,
} from './work-item-repository'

describe('computeRetryBackoffMs', () => {
  it('試行回数が増えるほど待機時間が伸びる', () => {
    expect(computeRetryBackoffMs(1)).toBeLessThan(computeRetryBackoffMs(2))
    expect(computeRetryBackoffMs(2)).toBeLessThan(computeRetryBackoffMs(3))
  })

  it('待機時間には上限がある', () => {
    expect(computeRetryBackoffMs(100)).toBe(computeRetryBackoffMs(1000))
  })
})

describe.skipIf(!process.env.DATABASE_URL)('enqueueWorkItem', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
  })

  it('同じ kind + triggerType + triggerId を再投入しても重複しない', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-1',
    })
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-1',
    })

    const count = await prisma.analysisWorkItem.count()
    expect(count).toBe(1)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('claimNextWorkItem / completeWorkItem', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
  })

  it('lease 期限切れの WorkItem を別の worker が再取得できる', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-2',
    })
    const first = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-a',
      leaseDurationMs: -1000,
    })
    expect(first?.leaseOwner).toBe('worker-a')

    const second = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-b',
      leaseDurationMs: 60_000,
    })
    expect(second?.id).toBe(first?.id)
    expect(second?.leaseOwner).toBe('worker-b')
  })

  it('maxAttempts 到達済みの lease 切れ WorkItem は通常 claim しない', async () => {
    const item = await prisma.analysisWorkItem.create({
      data: {
        kind: 'label_metrics',
        triggerType: 'crawl_run',
        triggerId: 'crawl-exhausted-claim',
        status: 'leased',
        attemptCount: 5,
        maxAttempts: 5,
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    })

    const claimed = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-b',
      leaseDurationMs: 60_000,
    })

    expect(claimed).toBeUndefined()
    const row = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(row.attemptCount).toBe(5)
    expect(row.leaseOwner).toBe('dead-worker')
  })

  it('maxAttempts 到達済み lease 切れ WorkItem を dead-letter し stale AnalysisRun も閉じる', async () => {
    const item = await prisma.analysisWorkItem.create({
      data: {
        kind: 'label_metrics',
        triggerType: 'crawl_run',
        triggerId: 'crawl-exhausted-dead',
        status: 'leased',
        attemptCount: 5,
        maxAttempts: 5,
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    })
    const run = await prisma.analysisRun.create({
      data: { workItemId: item.id, attemptNumber: 5, status: 'running' },
    })

    const dead = await deadLetterExhaustedWorkItem(prisma, { kinds: ['label_metrics'] })

    expect(dead?.id).toBe(item.id)
    expect(dead?.status).toBe('dead')
    expect(dead?.attemptCount).toBe(5)
    expect(dead?.leaseOwner).toBeNull()
    const closedRun = await prisma.analysisRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(closedRun.status).toBe('failed')
    expect(closedRun.finishedAt).not.toBeNull()
  })

  it('lease 切れを再 claim すると前 attempt の running AnalysisRun を failed に閉じる', async () => {
    const item = await prisma.analysisWorkItem.create({
      data: {
        kind: 'label_metrics',
        triggerType: 'crawl_run',
        triggerId: 'crawl-stale-analysis-run',
        status: 'leased',
        attemptCount: 1,
        maxAttempts: 5,
        leaseOwner: 'worker-a',
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    })
    const run = await prisma.analysisRun.create({
      data: { workItemId: item.id, attemptNumber: 1, status: 'running' },
    })

    const reclaimed = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-b',
      leaseDurationMs: 60_000,
    })

    expect(reclaimed?.attemptCount).toBe(2)
    const closedRun = await prisma.analysisRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(closedRun.status).toBe('failed')
    expect(closedRun.finishedAt).not.toBeNull()
  })

  it('現在 owner は実行中 WorkItem の lease を延長できる', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-renew-1',
    })
    const claimed = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-a',
      leaseDurationMs: 1000,
    })
    if (!claimed?.leaseExpiresAt) throw new Error('claim に失敗した')

    const renewed = await renewWorkItemLease(prisma, {
      workItemId: claimed.id,
      leaseOwner: 'worker-a',
      leaseDurationMs: 60_000,
    })

    expect(renewed).toBe(true)
    const row = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: claimed.id } })
    expect(row.leaseExpiresAt?.getTime()).toBeGreaterThan(claimed.leaseExpiresAt.getTime())
  })

  it('別 owner は WorkItem の lease を延長できない', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-renew-2',
    })
    const claimed = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-a',
      leaseDurationMs: 60_000,
    })
    if (!claimed) throw new Error('claim に失敗した')

    const renewed = await renewWorkItemLease(prisma, {
      workItemId: claimed.id,
      leaseOwner: 'worker-b',
      leaseDurationMs: 120_000,
    })

    expect(renewed).toBe(false)
  })

  it('failed で終了した WorkItem を再 claim できる', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-4',
    })
    const claimed = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-a',
      leaseDurationMs: 60_000,
    })
    if (!claimed) throw new Error('claim に失敗した')

    await completeWorkItem(prisma, {
      workItemId: claimed.id,
      leaseOwner: 'worker-a',
      status: 'failed',
      errorSummary: 'boom',
    })

    const retried = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-b',
      leaseDurationMs: 60_000,
    })
    expect(retried?.id).toBe(claimed.id)
    expect(retried?.status).toBe('leased')
  })

  it('dead で終了した WorkItem は再 claim されない', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-5',
    })
    const claimed = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-a',
      leaseDurationMs: 60_000,
    })
    if (!claimed) throw new Error('claim に失敗した')

    await completeWorkItem(prisma, {
      workItemId: claimed.id,
      leaseOwner: 'worker-a',
      status: 'dead',
    })

    const retried = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-b',
      leaseDurationMs: 60_000,
    })
    expect(retried).toBeUndefined()
  })

  it('期限切れ worker は completeWorkItem で結果を上書きできない', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-3',
    })
    const claimed = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-a',
      leaseDurationMs: -1000,
    })
    if (!claimed) throw new Error('claim に失敗した')

    // worker-a の lease はすでに期限切れのため、別 worker が再 claim している想定。
    await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-b',
      leaseDurationMs: 60_000,
    })

    const updated = await completeWorkItem(prisma, {
      workItemId: claimed.id,
      leaseOwner: 'worker-a',
      status: 'succeeded',
    })
    expect(updated).toBe(false)

    const row = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: claimed.id } })
    expect(row.leaseOwner).toBe('worker-b')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('failed 時の再試行 backoff', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
  })

  it('retryAvailableAt を渡すと即時の再 claim を防ぐ', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-backoff-1',
    })
    const claimed = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-a',
      leaseDurationMs: 60_000,
    })
    if (!claimed) throw new Error('claim に失敗した')

    await completeWorkItem(prisma, {
      workItemId: claimed.id,
      leaseOwner: 'worker-a',
      status: 'failed',
      errorSummary: 'boom',
      retryAvailableAt: new Date(Date.now() + 60_000),
    })

    const retried = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-b',
      leaseDurationMs: 60_000,
    })
    expect(retried).toBeUndefined()
  })

  it('succeeded では retryAvailableAt を渡しても availableAt を進めない', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-backoff-2',
    })
    const claimed = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-a',
      leaseDurationMs: 60_000,
    })
    if (!claimed) throw new Error('claim に失敗した')

    await completeWorkItem(prisma, {
      workItemId: claimed.id,
      leaseOwner: 'worker-a',
      status: 'succeeded',
      retryAvailableAt: new Date(Date.now() + 60_000),
    })

    const row = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: claimed.id } })
    expect(row.availableAt.getTime()).toBeLessThanOrEqual(Date.now())
  })
})

describe.skipIf(!process.env.DATABASE_URL)('startAnalysisRun / finishAnalysisRun', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
  })

  it('attempt の開始と終了を AnalysisRun へ記録する', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-run-record-1',
    })
    const claimed = await claimNextWorkItem(prisma, {
      kinds: ['label_metrics'],
      leaseOwner: 'worker-a',
      leaseDurationMs: 60_000,
    })
    if (!claimed) throw new Error('claim に失敗した')

    const analysisRunId = await startAnalysisRun(prisma, {
      workItemId: claimed.id,
      attemptNumber: claimed.attemptCount,
    })
    await finishAnalysisRun(prisma, {
      analysisRunId,
      status: 'failed',
      errorSummary: 'boom',
    })

    const run = await prisma.analysisRun.findUniqueOrThrow({ where: { id: analysisRunId } })
    expect(run.attemptNumber).toBe(1)
    expect(run.status).toBe('failed')
    expect(run.errorSummary).toBe('boom')
    expect(run.finishedAt).not.toBeNull()
  })
})
