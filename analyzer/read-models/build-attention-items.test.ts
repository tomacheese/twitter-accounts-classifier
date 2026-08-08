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

  it('低い severity が大量にあっても後から検出された critical を落とさない', async () => {
    const oldDetectedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await prisma.operationalIssue.createMany({
      data: Array.from({ length: 30 }, () => ({
        component: 'crawl',
        type: 'run_failure',
        fingerprint: `fingerprint-${randomUUID()}`,
        status: 'active',
        severity: 'low',
        firstDetectedAt: oldDetectedAt,
      })),
    })
    const criticalIssue = await prisma.operationalIssue.create({
      data: {
        component: 'analyzer',
        type: 'stage_failure',
        fingerprint: `fingerprint-${randomUUID()}`,
        status: 'active',
        severity: 'critical',
        firstDetectedAt: new Date(),
      },
    })

    const generationId = `generation-${randomUUID()}`
    await buildAttentionItems(prisma, { generationId, sourceWatermarkAt: new Date() })

    const rows = await prisma.attentionItemCurrent.findMany({
      where: { generationId },
      orderBy: [{ priority: 'asc' }],
    })
    expect(rows[0]?.sourceId).toBe(criticalIssue.id)
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

  it('同一 severity が取得上限を超えても、より新しいが recurring な Finding を候補から落とさない', async () => {
    const oldDetectedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await prisma.reviewFinding.createMany({
      data: Array.from({ length: 200 }, () => ({
        fingerprint: `fingerprint-${randomUUID()}`,
        identityVersion: 1,
        type: 'label_count_drop',
        primaryScopeType: 'label',
        primaryScopeId: 'label-1',
        status: 'active',
        currentSeverity: 'critical',
        maximumSeverity: 'critical',
        firstDetectedAt: oldDetectedAt,
      })),
    })
    const recurringFinding = await prisma.reviewFinding.create({
      data: {
        fingerprint: `fingerprint-${randomUUID()}`,
        identityVersion: 1,
        type: 'label_count_drop',
        primaryScopeType: 'label',
        primaryScopeId: 'label-2',
        status: 'recurring',
        currentSeverity: 'critical',
        maximumSeverity: 'critical',
        firstDetectedAt: new Date(),
      },
    })
    await prisma.reviewFindingOccurrence.create({
      data: {
        findingId: recurringFinding.id,
        stateTransition: 'recurring',
        severity: 'critical',
        sourceType: 'label_metric',
        sourceId: 'label-2',
        affectedCount: 90,
        totalCount: 100,
        policyHash: 'policy-1',
        detectorVersion: 'v1',
        observationKey: randomUUID(),
      },
    })

    const generationId = `generation-${randomUUID()}`
    await buildAttentionItems(prisma, { generationId, sourceWatermarkAt: new Date() })

    const rows = await prisma.attentionItemCurrent.findMany({
      where: { generationId },
      orderBy: [{ priority: 'asc' }],
    })
    expect(rows[0]?.sourceId).toBe(recurringFinding.id)
  })
})
