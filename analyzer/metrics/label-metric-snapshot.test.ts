import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import { generateLabelMetricSnapshots } from './label-metric-snapshot'

describe('generateLabelMetricSnapshots', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.labelMetricSnapshot.deleteMany()
  })

  it('再実行しても sourceCrawlRunId + labelDefinitionId ごとに1行のみになる', async () => {
    const input = {
      crawlRunId: 'crawl-metric-1',
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
})
