import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from './client'
import { enqueueWorkItem } from './analysis-work-item-repository'

describe('enqueueWorkItem (crawler)', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
  })

  it('同じ kind + triggerType + triggerId を重複投入しない', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-x',
    })
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-x',
    })
    expect(await prisma.analysisWorkItem.count()).toBe(1)
  })
})
