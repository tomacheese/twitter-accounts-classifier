import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildAttentionItems } from './build-attention-items'

describe.skipIf(!process.env.DATABASE_URL)('buildAttentionItems', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.attentionItemCurrent.deleteMany()
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
    await prisma.findingEvidence.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
  })

  it('severity の高い順に並び、上限 8 件だけを作る', async () => {
    for (let index = 0; index < 10; index++) {
      await prisma.operationalIssue.create({
        data: {
          component: 'crawl',
          type: 'run_failure',
          fingerprint: `fingerprint-${randomUUID()}`,
          status: 'active',
          severity: index === 0 ? 'critical' : 'low',
        },
      })
    }

    const generationId = `generation-${randomUUID()}`
    const result = await buildAttentionItems(prisma, {
      generationId,
      sourceWatermarkAt: new Date(),
    })

    expect(result.rowCount).toBe(8)

    const rows = await prisma.attentionItemCurrent.findMany({
      where: { generationId },
      orderBy: [{ priority: 'asc' }],
    })
    expect(rows).toHaveLength(8)
    expect(rows[0]?.severity).toBe('critical')
  })

  it('resolved な OperationalIssue と ReviewFinding は含まれない', async () => {
    await prisma.operationalIssue.create({
      data: {
        component: 'crawl',
        type: 'run_failure',
        fingerprint: `fingerprint-${randomUUID()}`,
        status: 'resolved',
        severity: 'critical',
      },
    })
    await prisma.reviewFinding.create({
      data: {
        fingerprint: `fingerprint-${randomUUID()}`,
        identityVersion: 1,
        type: 'label_count_drop',
        primaryScopeType: 'label',
        primaryScopeId: 'label-1',
        status: 'resolved',
        currentSeverity: 'critical',
        maximumSeverity: 'critical',
      },
    })

    const generationId = `generation-${randomUUID()}`
    const result = await buildAttentionItems(prisma, {
      generationId,
      sourceWatermarkAt: new Date(),
    })

    expect(result.rowCount).toBe(0)
  })
})
