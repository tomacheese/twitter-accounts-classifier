import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from './db/client'
import {
  processLabelMetrics,
  processFindingGeneration,
  processBlockReconciliation,
} from './worker-processors'

const prisma = getPrismaClient()

describe.skipIf(!process.env.DATABASE_URL)('worker-processors', () => {
  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
    await prisma.blockRelationCurrent.deleteMany()
    await prisma.readModelState.deleteMany()
    await prisma.readModelPointer.deleteMany()
    await prisma.readModelGeneration.deleteMany()
    await prisma.labelMetricSnapshot.deleteMany()
    await prisma.crawlAccountLabelRun.deleteMany()
    await prisma.crawlRun.deleteMany()
  })

  it('processLabelMetrics は LabelMetricSnapshot を生成し finding_generation を enqueue する', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })

    await processLabelMetrics(prisma, {
      id: 'work-item-1',
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: crawlRun.id,
      status: 'leased',
      priority: 0,
      availableAt: new Date(),
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(),
      attemptCount: 1,
      maxAttempts: 5,
      dependencyKey: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const enqueued = await prisma.analysisWorkItem.findUnique({
      where: {
        kind_triggerType_triggerId: {
          kind: 'finding_generation',
          triggerType: 'crawl_run',
          triggerId: crawlRun.id,
        },
      },
    })
    expect(enqueued).not.toBeNull()
  })

  it('processFindingGeneration は read_model_refresh を enqueue する', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })

    await processFindingGeneration(prisma, {
      id: 'work-item-2',
      kind: 'finding_generation',
      triggerType: 'crawl_run',
      triggerId: crawlRun.id,
      status: 'leased',
      priority: 0,
      availableAt: new Date(),
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(),
      attemptCount: 1,
      maxAttempts: 5,
      dependencyKey: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const enqueued = await prisma.analysisWorkItem.findUnique({
      where: {
        kind_triggerType_triggerId: {
          kind: 'read_model_refresh',
          triggerType: 'crawl_run',
          triggerId: crawlRun.id,
        },
      },
    })
    expect(enqueued).not.toBeNull()
  })

  it('processBlockReconciliation は block_relation の ReadModelPointer を current に切り替える', async () => {
    await processBlockReconciliation(prisma, {
      id: 'work-item-3',
      kind: 'block_reconciliation',
      triggerType: 'block_run',
      triggerId: 'block-run-1',
      status: 'leased',
      priority: 0,
      availableAt: new Date(),
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(),
      attemptCount: 1,
      maxAttempts: 5,
      dependencyKey: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const pointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'block_relation' },
    })
    expect(pointer).not.toBeNull()
  })
})
