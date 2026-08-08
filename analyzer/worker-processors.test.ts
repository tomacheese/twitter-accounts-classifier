import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from './db/client'
import {
  processLabelMetrics,
  processFindingGeneration,
  processBlockReconciliation,
  processRetentionSweep,
} from './worker-processors'

const prisma = getPrismaClient()

describe.skipIf(!process.env.DATABASE_URL)('worker-processors', () => {
  beforeEach(async () => {
    await prisma.operationStage.deleteMany()
    await prisma.operationCycle.deleteMany()
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.attentionItemCurrent.deleteMany()
    await prisma.overviewSnapshot.deleteMany()
    await prisma.blockRelationCurrent.deleteMany()
    await prisma.readModelState.deleteMany()
    await prisma.readModelPointer.deleteMany()
    await prisma.readModelGeneration.deleteMany()
    await prisma.labelMetricSnapshot.deleteMany()
    await prisma.crawlAccountLabelRun.deleteMany()
    await prisma.crawlRun.deleteMany()
    await prisma.blockAccountRun.deleteMany()
    await prisma.blockRun.deleteMany()
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
    const blockRun = await prisma.blockRun.create({
      data: {
        id: `block-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })

    await processBlockReconciliation(prisma, {
      id: 'work-item-3',
      kind: 'block_reconciliation',
      triggerType: 'block_run',
      triggerId: blockRun.id,
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

    const attentionPointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'attention_items' },
    })
    expect(attentionPointer).not.toBeNull()
    const overviewPointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'overview_snapshot' },
    })
    expect(overviewPointer).not.toBeNull()
  })

  it('processRetentionSweep は次回分の WorkItem を即時 claim 可能な状態で enqueue しない', async () => {
    await processRetentionSweep(prisma, {
      id: 'work-item-4',
      kind: 'retention_sweep',
      triggerType: 'schedule',
      triggerId: '2026-01-01',
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

    const pending = await prisma.analysisWorkItem.findMany({
      where: { kind: 'retention_sweep' },
    })
    expect(pending).toHaveLength(0)
  })
})
