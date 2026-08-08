import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { evaluateShadow } from './evaluate-shadow'
import type { DetectionPolicy } from '../policy/schema'

const prisma = getPrismaClient()

const policy: DetectionPolicy = {
  schemaVersion: 1,
  policyVersion: 'test',
  rules: [
    {
      type: 'label_count_drop',
      enabled: true,
      detectorType: 'comparative',
      identityVersion: 1,
      severity: 'high',
      relativeThreshold: 0.1,
      minimumSampleSize: 10,
      activationCount: 1,
      resolutionCount: 1,
      criticalImmediate: false,
    },
  ],
}

describe.skipIf(!process.env.DATABASE_URL)('evaluateShadow', () => {
  beforeEach(async () => {
    await prisma.detectorEvaluation.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
    await prisma.labelMetricSnapshot.deleteMany()
  })

  it('DetectorEvaluation を isShadow: true で書き、ReviewFinding は一切作らない', async () => {
    const labelDefinitionId = `label-${randomUUID()}`
    const crawlRunId = `crawl-${randomUUID()}`

    await prisma.labelMetricSnapshot.create({
      data: {
        sourceCrawlRunId: crawlRunId,
        labelDefinitionId,
        observedAt: new Date(),
        sourceWatermarkAt: new Date(),
        evaluatedCount: 100,
        trueCount: 80,
        prevalence: 0.8,
        completeness: 'complete',
        policyHash: 'seed',
        analyzerVersion: '1',
      },
    })

    await evaluateShadow(prisma, { crawlRunId, policy, policyHash: 'shadow-hash' })

    const evaluations = await prisma.detectorEvaluation.findMany({
      where: { policyHash: 'shadow-hash' },
    })
    expect(evaluations).toHaveLength(1)
    expect(evaluations[0]?.isShadow).toBe(true)

    const findings = await prisma.reviewFinding.findMany()
    expect(findings).toHaveLength(0)
  })
})
