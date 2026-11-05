import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import { deriveWorkItemStage } from '../operations/cycle-common'
import {
  enqueueWorkItem,
  findWorkItemById,
  findWorkItemByKey,
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
    await prisma.analysisWorkItemDone.deleteMany()
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
    await prisma.analysisWorkItemDone.deleteMany()
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
    await prisma.analysisWorkItemDone.deleteMany()
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

  it('succeeded では retryAvailableAt を渡してもキュー表から台帳へ移るだけで再 claim されない', async () => {
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

    expect(await prisma.analysisWorkItem.findUnique({ where: { id: claimed.id } })).toBeNull()
    const done = await prisma.analysisWorkItemDone.findFirstOrThrow({
      where: { workItemId: claimed.id },
    })
    expect(done.triggerId).toBe('crawl-backoff-2')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('startAnalysisRun / finishAnalysisRun', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.analysisWorkItemDone.deleteMany()
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

describe.skipIf(!process.env.DATABASE_URL)('キューと完了台帳の分離', () => {
  const prisma = getPrismaClient()
  const key = { kind: 'label_metrics', triggerType: 'crawl_run', triggerId: 'ledger-1' }

  beforeEach(async () => {
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.analysisWorkItemDone.deleteMany()
  })

  /**
   * @param owner - lease owner
   * @param input - claim 対象の論理キー
   * @returns claim した WorkItem の id
   */
  async function claimOne(owner: string, input = key): Promise<number> {
    await enqueueWorkItem(prisma, input)
    const claimed = await claimNextWorkItem(prisma, {
      kinds: [input.kind],
      leaseOwner: owner,
      leaseDurationMs: 60_000,
    })
    if (!claimed) throw new Error('claim に失敗した')
    return claimed.id
  }

  it('succeeded で完了するとキュー表の行が消え、台帳に論理キーと元の値が残る', async () => {
    const id = await claimOne('worker-a')

    expect(
      await completeWorkItem(prisma, {
        workItemId: id,
        leaseOwner: 'worker-a',
        status: 'succeeded',
      }),
    ).toBe(true)

    expect(await prisma.analysisWorkItem.count()).toBe(0)
    const done = await prisma.analysisWorkItemDone.findUniqueOrThrow({
      where: { kind_triggerType_triggerId: key },
    })
    expect(done.workItemId).toBe(id)
    expect(done.attemptCount).toBe(1)
  })

  it('完了済みの論理キーは、再度 enqueue してもキューに入らない', async () => {
    const id = await claimOne('worker-a')
    await completeWorkItem(prisma, { workItemId: id, leaseOwner: 'worker-a', status: 'succeeded' })

    await enqueueWorkItem(prisma, key)

    expect(await prisma.analysisWorkItem.count()).toBe(0)
  })

  it('キュー表にある論理キー (queued・dead) の再 enqueue は何もしない', async () => {
    await enqueueWorkItem(prisma, key)
    await enqueueWorkItem(prisma, key)
    expect(await prisma.analysisWorkItem.count()).toBe(1)

    const { id } = await prisma.analysisWorkItem.findFirstOrThrow()
    await prisma.analysisWorkItem.update({ where: { id }, data: { status: 'dead' } })
    await enqueueWorkItem(prisma, key)

    const rows = await prisma.analysisWorkItem.findMany()
    expect(rows.map((row) => [row.id, row.status])).toEqual([[id, 'dead']])
  })

  it('既存の論理キーを再 enqueue しても識別子を消費しない', async () => {
    await enqueueWorkItem(prisma, key)
    for (let i = 0; i < 5; i++) await enqueueWorkItem(prisma, key)
    await enqueueWorkItem(prisma, { ...key, triggerId: 'ledger-2' })

    const rows = await prisma.analysisWorkItem.findMany({ orderBy: { id: 'asc' } })
    const ids = rows.map((row) => row.id)
    expect(ids[1] - ids[0]).toBe(1)
  })

  it('同じ論理キーを並行して enqueue しても 1 行だけになる', async () => {
    await Promise.all(Array.from({ length: 20 }, () => enqueueWorkItem(prisma, key)))

    expect(await prisma.analysisWorkItem.count()).toBe(1)
  })

  it('lease を失った owner の succeeded は台帳に記録せず、キュー表の行も残す', async () => {
    const id = await claimOne('worker-a')

    const completed = await completeWorkItem(prisma, {
      workItemId: id,
      leaseOwner: 'worker-b',
      status: 'succeeded',
    })

    expect(completed).toBe(false)
    expect(await prisma.analysisWorkItemDone.count()).toBe(0)
    const row = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id } })
    expect(row.leaseOwner).toBe('worker-a')
  })

  it('同じ WorkItem の完了を並行して呼んでも、成功するのは 1 回だけで台帳は 1 行', async () => {
    const id = await claimOne('worker-a')

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        completeWorkItem(prisma, { workItemId: id, leaseOwner: 'worker-a', status: 'succeeded' }),
      ),
    )

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await prisma.analysisWorkItemDone.count()).toBe(1)
    expect(await prisma.analysisWorkItem.count()).toBe(0)
  })

  it('並行 claim は同じ WorkItem を二重に取らない', async () => {
    for (let i = 0; i < 12; i++) {
      await enqueueWorkItem(prisma, { ...key, triggerId: `claim-${i}` })
    }

    const claimed = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        claimNextWorkItem(prisma, {
          kinds: [key.kind],
          leaseOwner: `worker-${i}`,
          leaseDurationMs: 60_000,
        }),
      ),
    )

    const ids = claimed.flatMap((item) => (item ? [item.id] : []))
    expect(ids).toHaveLength(12)
    expect(new Set(ids).size).toBe(12)
  })

  it('lease 切れ・再試行・dead を経ても、キュー表に行が残り台帳には入らない', async () => {
    await enqueueWorkItem(prisma, key)
    await prisma.analysisWorkItem.updateMany({ data: { maxAttempts: 2 } })
    const first = await claimNextWorkItem(prisma, {
      kinds: [key.kind],
      leaseOwner: 'worker-a',
      leaseDurationMs: -1000,
    })
    const second = await claimNextWorkItem(prisma, {
      kinds: [key.kind],
      leaseOwner: 'worker-b',
      leaseDurationMs: -1000,
    })
    expect([first?.attemptCount, second?.attemptCount]).toEqual([1, 2])

    expect(
      await claimNextWorkItem(prisma, {
        kinds: [key.kind],
        leaseOwner: 'worker-c',
        leaseDurationMs: 60_000,
      }),
    ).toBeUndefined()
    const dead = await deadLetterExhaustedWorkItem(prisma, { kinds: [key.kind] })

    expect(dead?.status).toBe('dead')
    expect(await prisma.analysisWorkItem.count()).toBe(1)
    expect(await prisma.analysisWorkItemDone.count()).toBe(0)
  })

  describe('完了済み WorkItem を指す参照 (キュー表に行が無い)', () => {
    it('論理キーでも id でも台帳から復元でき、AnalysisRun は元の id で引ける', async () => {
      const id = await claimOne('worker-a')
      const runId = await startAnalysisRun(prisma, { workItemId: id, attemptNumber: 1 })
      await finishAnalysisRun(prisma, { analysisRunId: runId, status: 'succeeded' })
      await completeWorkItem(prisma, {
        workItemId: id,
        leaseOwner: 'worker-a',
        status: 'succeeded',
      })

      const byKey = await findWorkItemByKey(prisma, key)
      const byId = await findWorkItemById(prisma, id)

      expect(byKey).toMatchObject({ id, status: 'succeeded', attemptCount: 1, ...key })
      expect(byId).toEqual(byKey)
      const run = await prisma.analysisRun.findFirstOrThrow({ where: { workItemId: byKey?.id } })
      expect(run.id).toBe(runId)
    })

    it('deriveWorkItemStage は完了済みの WorkItem を succeeded とし、最新の AnalysisRun を元の id で結びつける', async () => {
      const id = await claimOne('worker-a')
      const runId = await startAnalysisRun(prisma, { workItemId: id, attemptNumber: 1 })
      await finishAnalysisRun(prisma, { analysisRunId: runId, status: 'succeeded' })
      await completeWorkItem(prisma, {
        workItemId: id,
        leaseOwner: 'worker-a',
        status: 'succeeded',
      })

      const stage = await deriveWorkItemStage(prisma, key.kind, key.triggerType, key.triggerId)

      expect(stage.status).toBe('succeeded')
      expect(stage.workItemExists).toBe(true)
      expect(stage.attemptCount).toBe(1)
      expect(stage.analysisRunId).toBe(runId)
      expect(stage.finishedAt).toBeInstanceOf(Date)
    })

    it('キュー表にある WorkItem は台帳より優先して返し、どちらにも無ければ undefined', async () => {
      await enqueueWorkItem(prisma, key)

      const queued = await findWorkItemByKey(prisma, key)
      expect(queued?.status).toBe('queued')
      expect(await findWorkItemByKey(prisma, { ...key, triggerId: 'none' })).toBeUndefined()
      expect(await findWorkItemById(prisma, 2_000_000_000)).toBeUndefined()
    })
  })
})
