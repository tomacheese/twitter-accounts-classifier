import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import {
  deriveCompletenessFromRunStatus,
  generateLabelMetricSnapshots,
} from './label-metric-snapshot'

describe('deriveCompletenessFromRunStatus', () => {
  it('success のみ complete として扱う', () => {
    expect(deriveCompletenessFromRunStatus('success')).toBe('complete')
  })

  it('partial・failed は complete として扱わない', () => {
    expect(deriveCompletenessFromRunStatus('partial')).toBe('partial')
    expect(deriveCompletenessFromRunStatus('failed')).toBe('partial')
  })

  it('解釈できない status は unknown になる', () => {
    expect(deriveCompletenessFromRunStatus('running')).toBe('unknown')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('generateLabelMetricSnapshots', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.labelMetricSnapshot.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.accountLabel.deleteMany()
  })

  it('再実行しても sourceCrawlRunId + labelDefinitionId ごとに1行のみになる', async () => {
    const input = {
      crawlRunId: 'crawl-metric-1',
      crawlRunStatus: 'success',
      sourceWatermarkAt: new Date(),
      policyHash: 'hash-1',
      analyzerVersion: 'test',
    }
    await generateLabelMetricSnapshots(prisma, input)
    await generateLabelMetricSnapshots(prisma, input)

    const rows = await prisma.labelMetricSnapshot.findMany({
      where: { sourceCrawlRunId: 'crawl-metric-1' },
    })
    const uniqueLabelIds = new Set(rows.map((r) => r.labelDefinitionId))
    expect(rows.length).toBe(uniqueLabelIds.size)
  })

  it('基準時刻より後のラベル変更を集計に含めない', async () => {
    const label = await prisma.labelDefinition.upsert({
      where: { key: `metric-test-${randomUUID()}` },
      create: { key: `metric-test-${randomUUID()}`, description: 'metric test' },
      update: {},
    })
    const account = await prisma.account.create({
      data: {
        id: `acct-${randomUUID()}`,
        screenName: `user_${randomUUID().slice(0, 8)}`,
        displayName: 'test user',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      },
    })
    const watermark = new Date('2026-01-10T00:00:00Z')
    await prisma.accountLabel.createMany({
      data: [
        {
          accountId: account.id,
          labelDefinitionId: label.id,
          value: true,
          confidence: 0.9,
          reason: 'matched keyword',
          method: 'rule',
          ruleVersion: '1',
          labeledAt: new Date('2026-01-05T00:00:00Z'),
        },
        {
          accountId: account.id,
          labelDefinitionId: label.id,
          value: false,
          confidence: 0.2,
          reason: 'no match',
          method: 'rule',
          ruleVersion: '2',
          labeledAt: new Date('2026-01-20T00:00:00Z'),
        },
      ],
    })

    await generateLabelMetricSnapshots(prisma, {
      crawlRunId: 'crawl-metric-watermark',
      crawlRunStatus: 'success',
      sourceWatermarkAt: watermark,
      policyHash: 'hash-1',
      analyzerVersion: 'test',
    })

    const snapshot = await prisma.labelMetricSnapshot.findUniqueOrThrow({
      where: {
        sourceCrawlRunId_labelDefinitionId: {
          sourceCrawlRunId: 'crawl-metric-watermark',
          labelDefinitionId: label.id,
        },
      },
    })
    expect(snapshot.evaluatedCount).toBe(1)
    expect(snapshot.trueCount).toBe(1)
    expect(snapshot.reasonDistribution).toEqual({ 'matched keyword': 1 })
    expect(snapshot.ruleVersionDistribution).toEqual({ '1': 1 })
    expect(snapshot.confidenceBuckets).toEqual({ '0.9-1.0': 1 })
    expect(snapshot.trueConfidenceAverage).toBeCloseTo(0.9)

    await prisma.accountLabel.deleteMany({ where: { labelDefinitionId: label.id } })
    await prisma.labelDefinition.delete({ where: { id: label.id } })
    await prisma.account.delete({ where: { id: account.id } })
  })

  it('partial な CrawlRun の snapshot は complete にしない', async () => {
    await generateLabelMetricSnapshots(prisma, {
      crawlRunId: 'crawl-metric-partial',
      crawlRunStatus: 'partial',
      sourceWatermarkAt: new Date(),
      policyHash: 'hash-1',
      analyzerVersion: 'test',
    })

    const rows = await prisma.labelMetricSnapshot.findMany({
      where: { sourceCrawlRunId: 'crawl-metric-partial' },
    })
    for (const row of rows) {
      expect(row.completeness).toBe('partial')
    }
  })
})
