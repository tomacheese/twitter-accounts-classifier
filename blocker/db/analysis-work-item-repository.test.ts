import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from './client'
import { enqueueWorkItem } from './analysis-work-item-repository'

describe.skipIf(!process.env.DATABASE_URL)('enqueueWorkItem (blocker)', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
    await prisma.analysisWorkItemDone.deleteMany()
  })

  it('同じ kind + triggerType + triggerId を重複投入しない', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'block_reconciliation',
      triggerType: 'block_run',
      triggerId: 'block-x',
    })
    await enqueueWorkItem(prisma, {
      kind: 'block_reconciliation',
      triggerType: 'block_run',
      triggerId: 'block-x',
    })
    expect(await prisma.analysisWorkItem.count()).toBe(1)
  })

  it('台帳に完了済みの論理キーがあれば、キューに入れない', async () => {
    await prisma.analysisWorkItemDone.create({
      data: {
        kind: 'block_reconciliation',
        triggerType: 'block_run',
        triggerId: 'block-done',
        workItemId: 1,
        attemptCount: 1,
        createdAt: new Date(),
      },
    })

    await enqueueWorkItem(prisma, {
      kind: 'block_reconciliation',
      triggerType: 'block_run',
      triggerId: 'block-done',
    })

    expect(await prisma.analysisWorkItem.count()).toBe(0)
  })
})
