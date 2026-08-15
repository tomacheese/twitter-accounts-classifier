import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import * as labelMetricSnapshotModule from './metrics/label-metric-snapshot'
import * as serializeLabelFindingsModule from './findings/serialize-label-findings'
import * as publishModule from './read-models/publish'
import { processAccountSummaryRefresh, processLabelAggregateRefresh } from './worker-processors'

function makeLabelAggregatePrisma(
  sourceStatus: 'success' | 'partial' | 'failed',
  completeSnapshotCount: number,
) {
  return {
    labelEvidenceEpoch: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'epoch-1',
        sourceWatermarkAt: new Date('2026-08-15T00:00:00Z'),
        crawlRun: { status: sourceStatus },
      }),
    },
    labelMetricSnapshot: { count: vi.fn().mockResolvedValue(completeSnapshotCount) },
    labelDefinition: { count: vi.fn().mockResolvedValue(1) },
  } as unknown as PrismaClient
}

function mockLabelAggregateDependencies() {
  vi.spyOn(labelMetricSnapshotModule, 'buildLabelAggregateSnapshotSet').mockResolvedValue({
    triggerWorkItemId: 'work-1',
    snapshotAt: new Date('2026-08-15T00:00:00Z'),
    reused: false,
  })
  const runFindings = vi
    .spyOn(serializeLabelFindingsModule, 'runLabelFindingsSerialized')
    .mockResolvedValue(undefined)
  vi.spyOn(publishModule, 'publishGeneration').mockResolvedValue('generation-1')
  return runFindings
}

describe('processAccountSummaryRefresh transaction budget', () => {
  it('passes an explicit 30 second timeout to the write transaction', async () => {
    const observedAt = new Date('2026-08-10T00:00:00Z')
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1) }
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback(tx))
    const prisma = {
      accountClassificationObservation: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'observation-1',
          accountId: 'account-1',
          crawlRunId: 'crawl-1',
          observedAt,
        }),
      },
      account: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'account-1',
          screenName: 'Alice',
          displayName: 'Alice',
          lastCrawledAt: observedAt,
        }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      accountSummaryLatest: { findUnique: vi.fn().mockResolvedValue(null) },
      labelDefinition: { findMany: vi.fn().mockResolvedValue([]) },
      readModelState: { upsert: vi.fn().mockResolvedValue(undefined) },
      $transaction: transaction,
    } as unknown as PrismaClient

    await processAccountSummaryRefresh(prisma, {
      id: 'work-1',
      triggerId: 'observation-1',
    } as never)

    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 60_000 }),
    )
  })
})

describe('processLabelAggregateRefresh evidence eligibility', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('partial crawl でも全 snapshot が complete なら Finding 評価する', async () => {
    const runFindings = mockLabelAggregateDependencies()

    await processLabelAggregateRefresh(makeLabelAggregatePrisma('partial', 1), {
      id: 'work-1',
      triggerType: 'crawl_run',
      triggerId: 'crawl-1',
    } as never)

    expect(runFindings).toHaveBeenCalledOnce()
  })

  it('partial crawl で snapshot が incomplete なら Finding 評価しない', async () => {
    const runFindings = mockLabelAggregateDependencies()

    await processLabelAggregateRefresh(makeLabelAggregatePrisma('partial', 0), {
      id: 'work-1',
      triggerType: 'crawl_run',
      triggerId: 'crawl-1',
    } as never)

    expect(runFindings).not.toHaveBeenCalled()
  })

  it('failed crawl は全 snapshot が complete でも Finding 評価しない', async () => {
    const runFindings = mockLabelAggregateDependencies()

    await processLabelAggregateRefresh(makeLabelAggregatePrisma('failed', 1), {
      id: 'work-1',
      triggerType: 'crawl_run',
      triggerId: 'crawl-1',
    } as never)

    expect(runFindings).not.toHaveBeenCalled()
  })

  it('success crawl は従来どおり全 snapshot が complete なら Finding 評価する', async () => {
    const runFindings = mockLabelAggregateDependencies()

    await processLabelAggregateRefresh(makeLabelAggregatePrisma('success', 1), {
      id: 'work-1',
      triggerType: 'crawl_run',
      triggerId: 'crawl-1',
    } as never)

    expect(runFindings).toHaveBeenCalledOnce()
  })
})
