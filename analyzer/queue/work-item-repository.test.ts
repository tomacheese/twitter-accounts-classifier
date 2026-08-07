import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import { enqueueWorkItem, claimNextWorkItem, completeWorkItem } from './work-item-repository'

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
