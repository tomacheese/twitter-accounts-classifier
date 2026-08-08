import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from './client'
import { enqueueWorkItem } from './analysis-work-item-repository'

describe.skipIf(!process.env.DATABASE_URL)('enqueueWorkItem (blocker)', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
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
})
