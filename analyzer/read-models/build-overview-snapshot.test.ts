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

describe('buildOverviewSnapshot', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.overviewSnapshot.deleteMany()
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
    await prisma.operationStage.deleteMany()
    await prisma.operationCycle.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
  })

  it('active な OperationalIssue が無ければ healthy な snapshot を作る', async () => {
    const result = await buildOverviewSnapshot(prisma, { sourceWatermarkAt: new Date() })

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

    const result = await buildOverviewSnapshot(prisma, { sourceWatermarkAt: new Date() })

    const snapshot = await prisma.overviewSnapshot.findUniqueOrThrow({ where: { id: result.id } })
    expect(snapshot.operationalStatus).toBe('critical')
  })
})
