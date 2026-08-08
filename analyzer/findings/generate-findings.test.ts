import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getPrismaClient } from '../db/client'
import { generateFindingsForCrawlCycle } from './generate-findings'
import { computeFingerprint } from './fingerprint'
import type { DetectionPolicy, DetectionPolicyRule } from '../policy/schema'
import { randomUUID } from 'node:crypto'

const loggerWarn = vi.fn()

vi.mock('@book000/node-utils', () => ({
  Logger: {
    configure: () => ({
      warn: (...args: unknown[]): unknown => loggerWarn(...args) as unknown,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}))

const labelCountDropRule: DetectionPolicyRule = {
  type: 'label_count_drop',
  enabled: true,
  detectorType: 'comparative',
  identityVersion: 1,
  severity: 'high',
  minimumSampleSize: 10,
  relativeThreshold: 0.3,
  activationCount: 2,
  resolutionCount: 2,
  criticalImmediate: false,
}

const policy: DetectionPolicy = {
  schemaVersion: 1,
  policyVersion: 'test',
  rules: [labelCountDropRule],
}

describe.skipIf(!process.env.DATABASE_URL)('generateFindingsForCrawlCycle', () => {
  const prisma = getPrismaClient()
  let labelDefinitionId: string

  beforeEach(async () => {
    await prisma.findingEvidence.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
    await prisma.detectorEvaluation.deleteMany()
    await prisma.labelMetricSnapshot.deleteMany()

    const label = await prisma.labelDefinition.upsert({
      where: { key: 'generate-findings-test-label' },
      create: { key: 'generate-findings-test-label', description: 'test' },
      update: {},
    })
    labelDefinitionId = label.id
  })

  async function makeSnapshot(
    crawlRunId: string,
    trueCount: number,
    observedAt: Date,
    reasonDistribution?: Record<string, number>,
  ) {
    await prisma.labelMetricSnapshot.create({
      data: {
        sourceCrawlRunId: crawlRunId,
        labelDefinitionId,
        observedAt,
        sourceWatermarkAt: observedAt,
        evaluatedCount: 1000,
        trueCount,
        prevalence: trueCount / 1000,
        reasonDistribution: reasonDistribution ?? {},
        completeness: 'complete',
        policyHash: 'hash-1',
        analyzerVersion: 'test',
      },
    })
  }

  it('activationCount 回連続して exceeded になってから ReviewFinding が active になる', async () => {
    const run1 = `crawl-${randomUUID()}`
    const run2 = `crawl-${randomUUID()}`
    const run3 = `crawl-${randomUUID()}`

    // baseline は直前 snapshot に対する相対値のため、連続 2 回 activation させるには
    // 各 run が直前 run に対しても相対閾値を超えて減り続ける必要がある。
    await makeSnapshot(run1, 100, new Date('2026-08-01T00:00:00Z'))
    await makeSnapshot(run2, 50, new Date('2026-08-02T00:00:00Z'))
    await makeSnapshot(run3, 20, new Date('2026-08-03T00:00:00Z'))

    await generateFindingsForCrawlCycle(prisma, {
      crawlRunId: run2,
      policy,
      policyHash: 'hash-1',
      detectorVersion: 'v1',
    })
    const afterFirst = await prisma.reviewFinding.findMany({
      where: { primaryScopeId: labelDefinitionId },
    })
    expect(afterFirst).toHaveLength(0)

    await generateFindingsForCrawlCycle(prisma, {
      crawlRunId: run3,
      policy,
      policyHash: 'hash-1',
      detectorVersion: 'v1',
    })
    const afterSecond = await prisma.reviewFinding.findMany({
      where: { primaryScopeId: labelDefinitionId },
    })
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0]?.status).toBe('active')
  })

  it('fingerprint が同じなら 2 回目以降は既存 Finding の Occurrence を追加する', async () => {
    const run1 = `crawl-${randomUUID()}`
    const run2 = `crawl-${randomUUID()}`
    const run3 = `crawl-${randomUUID()}`
    const run4 = `crawl-${randomUUID()}`

    await makeSnapshot(run1, 100, new Date('2026-08-01T00:00:00Z'))
    await makeSnapshot(run2, 50, new Date('2026-08-02T00:00:00Z'))
    await makeSnapshot(run3, 20, new Date('2026-08-03T00:00:00Z'))
    await makeSnapshot(run4, 10, new Date('2026-08-04T00:00:00Z'))

    for (const crawlRunId of [run2, run3, run4]) {
      await generateFindingsForCrawlCycle(prisma, {
        crawlRunId,
        policy,
        policyHash: 'hash-1',
        detectorVersion: 'v1',
      })
    }

    const findings = await prisma.reviewFinding.findMany({
      where: { primaryScopeId: labelDefinitionId },
    })
    expect(findings).toHaveLength(1)

    const occurrences = await prisma.reviewFindingOccurrence.findMany({
      where: { findingId: findings[0]?.id },
    })
    expect(occurrences).toHaveLength(2)
  })

  it('completeness が unknown の snapshot は検出器へ渡さない', async () => {
    const run1 = `crawl-${randomUUID()}`
    const run2 = `crawl-${randomUUID()}`

    await makeSnapshot(run1, 100, new Date('2026-08-01T00:00:00Z'))
    await prisma.labelMetricSnapshot.create({
      data: {
        sourceCrawlRunId: run2,
        labelDefinitionId,
        observedAt: new Date('2026-08-02T00:00:00Z'),
        sourceWatermarkAt: new Date('2026-08-02T00:00:00Z'),
        evaluatedCount: 0,
        trueCount: 0,
        prevalence: 0,
        completeness: 'unknown',
        policyHash: 'hash-1',
        analyzerVersion: 'test',
      },
    })

    await generateFindingsForCrawlCycle(prisma, {
      crawlRunId: run2,
      policy,
      policyHash: 'hash-1',
      detectorVersion: 'v1',
    })

    const evaluationCount = await prisma.detectorEvaluation.count()
    expect(evaluationCount).toBe(0)
  })

  it('検出器が実装されていない有効ルールは警告を出す', async () => {
    loggerWarn.mockClear()
    const run1 = `crawl-${randomUUID()}`
    const run2 = `crawl-${randomUUID()}`
    await makeSnapshot(run1, 100, new Date('2026-08-01T00:00:00Z'))
    await makeSnapshot(run2, 50, new Date('2026-08-02T00:00:00Z'))

    await generateFindingsForCrawlCycle(prisma, {
      crawlRunId: run2,
      policy: {
        ...policy,
        rules: [
          ...policy.rules,
          {
            type: 'crawl_quality_degradation',
            enabled: true,
            detectorType: 'invariant',
            identityVersion: 1,
            severity: 'medium',
            activationCount: 1,
            resolutionCount: 1,
            criticalImmediate: false,
          },
        ],
      },
      policyHash: 'hash-1',
      detectorVersion: 'v1',
    })

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('crawl_quality_degradation') as unknown as string,
    )
  })

  it('同一 crawlRunId を再実行しても Finding/Occurrence/DetectorEvaluation が重複しない', async () => {
    const run1 = `crawl-${randomUUID()}`
    const run2 = `crawl-${randomUUID()}`

    await makeSnapshot(run1, 100, new Date('2026-08-01T00:00:00Z'))
    await makeSnapshot(run2, 50, new Date('2026-08-02T00:00:00Z'))

    const activateImmediatelyPolicy: DetectionPolicy = {
      ...policy,
      rules: [{ ...labelCountDropRule, activationCount: 1 }],
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      await generateFindingsForCrawlCycle(prisma, {
        crawlRunId: run2,
        policy: activateImmediatelyPolicy,
        policyHash: 'hash-1',
        detectorVersion: 'v1',
      })
    }

    const findings = await prisma.reviewFinding.findMany({
      where: { primaryScopeId: labelDefinitionId },
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.status).toBe('active')

    const occurrences = await prisma.reviewFindingOccurrence.findMany({
      where: { findingId: findings[0]?.id },
    })
    expect(occurrences).toHaveLength(1)

    const evaluationCount = await prisma.detectorEvaluation.count()
    expect(evaluationCount).toBe(1)
  })

  it('recurring は継続超過中も active に丸められず、resolutionCount 到達で resolved になる', async () => {
    const run1 = `crawl-${randomUUID()}`
    const run2 = `crawl-${randomUUID()}`
    const run3 = `crawl-${randomUUID()}`
    const run4 = `crawl-${randomUUID()}`
    const run5 = `crawl-${randomUUID()}`
    const run6 = `crawl-${randomUUID()}`

    await makeSnapshot(run1, 100, new Date('2026-08-01T00:00:00Z'))
    await makeSnapshot(run2, 50, new Date('2026-08-02T00:00:00Z'))
    await makeSnapshot(run3, 80, new Date('2026-08-03T00:00:00Z'))
    await makeSnapshot(run4, 30, new Date('2026-08-04T00:00:00Z'))
    await makeSnapshot(run5, 10, new Date('2026-08-05T00:00:00Z'))
    await makeSnapshot(run6, 90, new Date('2026-08-06T00:00:00Z'))

    const recurringPolicy: DetectionPolicy = {
      ...policy,
      rules: [
        {
          ...labelCountDropRule,
          activationCount: 1,
          resolutionCount: 1,
          recurrenceWindow: 'P30D',
        },
      ],
    }

    for (const crawlRunId of [run2, run3]) {
      await generateFindingsForCrawlCycle(prisma, {
        crawlRunId,
        policy: recurringPolicy,
        policyHash: 'hash-1',
        detectorVersion: 'v1',
      })
    }
    const afterResolve = await prisma.reviewFinding.findMany({
      where: { primaryScopeId: labelDefinitionId },
    })
    expect(afterResolve[0]?.status).toBe('resolved')

    await generateFindingsForCrawlCycle(prisma, {
      crawlRunId: run4,
      policy: recurringPolicy,
      policyHash: 'hash-1',
      detectorVersion: 'v1',
    })
    const afterRecur = await prisma.reviewFinding.findMany({
      where: { primaryScopeId: labelDefinitionId },
    })
    expect(afterRecur[0]?.status).toBe('recurring')
    expect(afterRecur[0]?.recurrenceCount).toBe(1)

    await generateFindingsForCrawlCycle(prisma, {
      crawlRunId: run5,
      policy: recurringPolicy,
      policyHash: 'hash-1',
      detectorVersion: 'v1',
    })
    const stillRecurring = await prisma.reviewFinding.findMany({
      where: { primaryScopeId: labelDefinitionId },
    })
    expect(stillRecurring[0]?.status).toBe('recurring')
    expect(stillRecurring[0]?.recurrenceCount).toBe(1)

    await generateFindingsForCrawlCycle(prisma, {
      crawlRunId: run6,
      policy: recurringPolicy,
      policyHash: 'hash-1',
      detectorVersion: 'v1',
    })
    const resolvedAgain = await prisma.reviewFinding.findMany({
      where: { primaryScopeId: labelDefinitionId },
    })
    expect(resolvedAgain[0]?.status).toBe('resolved')
  })

  it('reason_distribution_shift は最大変化幅以外の reason も観測し、外れた reason を resolve する', async () => {
    const run1 = `crawl-${randomUUID()}`
    const run2 = `crawl-${randomUUID()}`
    const run3 = `crawl-${randomUUID()}`

    await makeSnapshot(run1, 100, new Date('2026-08-01T00:00:00Z'), {
      bio_pattern: 100,
      screen_name_pattern: 100,
    })
    await makeSnapshot(run2, 100, new Date('2026-08-02T00:00:00Z'), {
      bio_pattern: 50,
      screen_name_pattern: 100,
    })
    await makeSnapshot(run3, 100, new Date('2026-08-03T00:00:00Z'), {
      bio_pattern: 50,
      screen_name_pattern: 20,
    })

    const reasonPolicy: DetectionPolicy = {
      schemaVersion: 1,
      policyVersion: 'test-reason',
      rules: [
        {
          type: 'reason_distribution_shift',
          enabled: true,
          detectorType: 'comparative',
          identityVersion: 1,
          severity: 'high',
          minimumSampleSize: 10,
          relativeThreshold: 0.3,
          activationCount: 1,
          resolutionCount: 1,
          criticalImmediate: false,
        },
      ],
    }

    for (const crawlRunId of [run2, run3]) {
      await generateFindingsForCrawlCycle(prisma, {
        crawlRunId,
        policy: reasonPolicy,
        policyHash: 'hash-1',
        detectorVersion: 'v1',
      })
    }

    const bioFingerprint = computeFingerprint('reason_distribution_shift', {
      label: labelDefinitionId,
      reason: 'bio_pattern',
    })
    const screenNameFingerprint = computeFingerprint('reason_distribution_shift', {
      label: labelDefinitionId,
      reason: 'screen_name_pattern',
    })

    const bioFinding = await prisma.reviewFinding.findFirst({
      where: { fingerprint: bioFingerprint },
    })
    const screenNameFinding = await prisma.reviewFinding.findFirst({
      where: { fingerprint: screenNameFingerprint },
    })

    expect(bioFinding?.status).toBe('resolved')
    expect(screenNameFinding?.status).toBe('active')
  })
})
