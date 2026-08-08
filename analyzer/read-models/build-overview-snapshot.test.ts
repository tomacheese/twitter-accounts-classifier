import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import {
  buildOverviewSnapshot,
  deriveOperationalStatus,
  deriveQualityStatus,
} from './build-overview-snapshot'

describe('deriveOperationalStatus', () => {
  it('critical な OperationalIssue があれば critical を返す', () => {
    expect(
      deriveOperationalStatus({
        hasCriticalIssue: true,
        hasFailedOrStaleCoreStage: false,
        hasUnknownCoreStage: false,
        hasActiveIssue: true,
      }),
    ).toBe('critical')
  })

  it('Crawl succeeded でも必須 Stage が failed なら critical を返す', () => {
    expect(
      deriveOperationalStatus({
        hasCriticalIssue: false,
        hasFailedOrStaleCoreStage: true,
        hasUnknownCoreStage: false,
        hasActiveIssue: false,
      }),
    ).toBe('critical')
  })

  it('critical がなく unknown Stage があれば unknown を返す', () => {
    expect(
      deriveOperationalStatus({
        hasCriticalIssue: false,
        hasFailedOrStaleCoreStage: false,
        hasUnknownCoreStage: true,
        hasActiveIssue: false,
      }),
    ).toBe('unknown')
  })

  it('critical・unknown がなく active issue があれば attention を返す', () => {
    expect(
      deriveOperationalStatus({
        hasCriticalIssue: false,
        hasFailedOrStaleCoreStage: false,
        hasUnknownCoreStage: false,
        hasActiveIssue: true,
      }),
    ).toBe('attention')
  })

  it('何もなければ healthy を返す', () => {
    expect(
      deriveOperationalStatus({
        hasCriticalIssue: false,
        hasFailedOrStaleCoreStage: false,
        hasUnknownCoreStage: false,
        hasActiveIssue: false,
      }),
    ).toBe('healthy')
  })
})

describe('deriveQualityStatus', () => {
  it('評価データが unknown なら過去状態を維持せず unknown を返す', () => {
    expect(
      deriveQualityStatus({
        isDataUnknown: true,
        hasDegradingFinding: true,
        hasWatchFinding: false,
      }),
    ).toBe('unknown')
  })

  it('degrading な Finding があれば degraded を返す', () => {
    expect(
      deriveQualityStatus({
        isDataUnknown: false,
        hasDegradingFinding: true,
        hasWatchFinding: false,
      }),
    ).toBe('degraded')
  })

  it('watch な Finding のみなら watch を返す', () => {
    expect(
      deriveQualityStatus({
        isDataUnknown: false,
        hasDegradingFinding: false,
        hasWatchFinding: true,
      }),
    ).toBe('watch')
  })

  it('何もなければ stable を返す', () => {
    expect(
      deriveQualityStatus({
        isDataUnknown: false,
        hasDegradingFinding: false,
        hasWatchFinding: false,
      }),
    ).toBe('stable')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('buildOverviewSnapshot', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.overviewSnapshot.deleteMany()
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
    await prisma.operationStage.deleteMany()
    await prisma.operationCycle.deleteMany()
    await prisma.findingEvidence.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
    await prisma.readModelState.deleteMany()
    await prisma.readModelPointer.deleteMany()
  })

  it('active な OperationalIssue が無ければ healthy な snapshot を作る', async () => {
    const result = await buildOverviewSnapshot(prisma, {
      generationId: randomUUID(),
      sourceWatermarkAt: new Date(),
    })

    const snapshot = await prisma.overviewSnapshot.findUniqueOrThrow({ where: { id: result.id } })
    expect(snapshot.operationalStatus).toBe('healthy')
    expect(snapshot.qualityStatus).toBe('stable')
  })

  it('critical な OperationalIssue があれば critical な snapshot を作る', async () => {
    await prisma.operationalIssue.create({
      data: {
        component: 'crawl',
        type: 'run_failure',
        fingerprint: `fingerprint-${randomUUID()}`,
        status: 'active',
        severity: 'critical',
      },
    })

    const result = await buildOverviewSnapshot(prisma, {
      generationId: randomUUID(),
      sourceWatermarkAt: new Date(),
    })

    const snapshot = await prisma.overviewSnapshot.findUniqueOrThrow({ where: { id: result.id } })
    expect(snapshot.operationalStatus).toBe('critical')
  })

  it('label_summary が stale なら qualityStatus を unknown にする', async () => {
    await prisma.readModelState.create({
      data: { modelKey: 'label_summary', schemaVersion: 1, status: 'stale' },
    })

    const result = await buildOverviewSnapshot(prisma, {
      generationId: randomUUID(),
      sourceWatermarkAt: new Date(),
    })

    const snapshot = await prisma.overviewSnapshot.findUniqueOrThrow({ where: { id: result.id } })
    expect(snapshot.qualityStatus).toBe('unknown')
  })

  it('label_summary が stale なら operationalStatus も critical にする', async () => {
    await prisma.readModelState.create({
      data: { modelKey: 'label_summary', schemaVersion: 1, status: 'stale' },
    })

    const result = await buildOverviewSnapshot(prisma, {
      generationId: randomUUID(),
      sourceWatermarkAt: new Date(),
    })

    const snapshot = await prisma.overviewSnapshot.findUniqueOrThrow({ where: { id: result.id } })
    expect(snapshot.operationalStatus).toBe('critical')
  })

  it('read model が delayed なら operationalStatus を unknown にする', async () => {
    await prisma.readModelState.create({
      data: { modelKey: 'account_summary', schemaVersion: 1, status: 'delayed' },
    })

    const result = await buildOverviewSnapshot(prisma, {
      generationId: randomUUID(),
      sourceWatermarkAt: new Date(),
    })

    const snapshot = await prisma.overviewSnapshot.findUniqueOrThrow({ where: { id: result.id } })
    expect(snapshot.operationalStatus).toBe('unknown')
  })

  it('必須 Stage が skipped (partial CrawlRun による見送り) なら operationalStatus は critical になる', async () => {
    const cycle = await prisma.operationCycle.create({
      data: {
        kind: 'crawl',
        sourceType: 'crawl_run',
        sourceId: `crawl-${randomUUID()}`,
        triggeredAt: new Date(),
        status: 'partial',
        modelVersion: '1',
      },
    })
    await prisma.operationStage.create({
      data: {
        cycleId: cycle.id,
        stageKey: 'read_model_refresh',
        sequence: 4,
        requiredness: 'required',
        status: 'skipped',
        errorSummary: 'crawl run is partial: read model refresh skipped',
      },
    })

    const result = await buildOverviewSnapshot(prisma, {
      generationId: randomUUID(),
      sourceWatermarkAt: new Date(),
    })

    const snapshot = await prisma.overviewSnapshot.findUniqueOrThrow({ where: { id: result.id } })
    expect(snapshot.operationalStatus).toBe('critical')
  })

  it('overview_snapshot 自身の旧 ReadModelState は build 中の判定に含めない', async () => {
    await prisma.readModelState.create({
      data: { modelKey: 'overview_snapshot', schemaVersion: 1, status: 'failed' },
    })

    const result = await buildOverviewSnapshot(prisma, {
      generationId: randomUUID(),
      sourceWatermarkAt: new Date(),
    })

    const snapshot = await prisma.overviewSnapshot.findUniqueOrThrow({ where: { id: result.id } })
    expect(snapshot.operationalStatus).toBe('healthy')
  })

  it('block_relation の ReadModelPointer が無ければ stale な block_relation state を無視する', async () => {
    await prisma.readModelState.create({
      data: { modelKey: 'block_relation', schemaVersion: 1, status: 'stale' },
    })

    const result = await buildOverviewSnapshot(prisma, {
      generationId: randomUUID(),
      sourceWatermarkAt: new Date(),
    })

    const snapshot = await prisma.overviewSnapshot.findUniqueOrThrow({ where: { id: result.id } })
    expect(snapshot.operationalStatus).toBe('healthy')
  })

  it('block_relation の ReadModelPointer があれば stale な block_relation state を critical に含める', async () => {
    await prisma.readModelState.create({
      data: { modelKey: 'block_relation', schemaVersion: 1, status: 'stale' },
    })
    await prisma.readModelPointer.create({
      data: { modelKey: 'block_relation', currentGenerationId: randomUUID() },
    })

    const result = await buildOverviewSnapshot(prisma, {
      generationId: randomUUID(),
      sourceWatermarkAt: new Date(),
    })

    const snapshot = await prisma.overviewSnapshot.findUniqueOrThrow({ where: { id: result.id } })
    expect(snapshot.operationalStatus).toBe('critical')
  })
})
