import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { detectRunFailures } from '../operational-issues/detect-run-failures'
import { cleanupDeprecatedWorkItemKindIssues } from './cleanup-deprecated-work-item-kinds'

describe.skipIf(!process.env.DATABASE_URL)('cleanupDeprecatedWorkItemKindIssues', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
  })

  it('apply: false では DB を変更せず対象件数のみ返す', async () => {
    await detectRunFailures(prisma, {
      component: 'analyzer:label_metrics',
      runId: `work-item-${randomUUID()}`,
      runStatus: 'dead',
      errorSummary: 'boom',
      now: new Date(),
    })

    const results = await cleanupDeprecatedWorkItemKindIssues(prisma, {
      apply: false,
      now: new Date(),
      before: new Date(),
    })

    const target = results.find((result) => result.component === 'analyzer:label_metrics')
    expect(target?.activeCountBefore).toBe(1)
    expect(target?.activeCountAfter).toBe(1)

    const issues = await prisma.operationalIssue.findMany({
      where: { component: 'analyzer:label_metrics' },
    })
    expect(issues[0]?.status).toBe('active')
  })

  it('label_metrics は before に関わらず全件 resolve される', async () => {
    await detectRunFailures(prisma, {
      component: 'analyzer:label_metrics',
      runId: `work-item-${randomUUID()}`,
      runStatus: 'dead',
      errorSummary: 'boom',
      now: new Date('2026-08-09T12:00:00Z'),
    })

    const results = await cleanupDeprecatedWorkItemKindIssues(prisma, {
      apply: true,
      now: new Date('2026-08-10T00:00:00Z'),
      before: new Date('2026-08-09T00:00:00Z'),
    })

    const target = results.find((result) => result.component === 'analyzer:label_metrics')
    expect(target?.activeCountBefore).toBe(1)
    expect(target?.activeCountAfter).toBe(0)
  })

  it('label_aggregate_refresh は before 以前の issue だけ resolve され、before より後の issue は残る', async () => {
    await detectRunFailures(prisma, {
      component: 'analyzer:label_aggregate_refresh',
      runId: `work-item-${randomUUID()}`,
      runStatus: 'dead',
      errorSummary: 'boom',
      now: new Date('2026-08-09T00:00:00Z'),
    })
    await detectRunFailures(prisma, {
      component: 'analyzer:label_aggregate_refresh',
      runId: `work-item-${randomUUID()}`,
      runStatus: 'dead',
      errorSummary: 'boom',
      now: new Date('2026-08-11T00:00:00Z'),
      observationKey: `after-cutoff-${randomUUID()}`,
    })

    const results = await cleanupDeprecatedWorkItemKindIssues(prisma, {
      apply: true,
      now: new Date('2026-08-12T00:00:00Z'),
      before: new Date('2026-08-10T00:00:00Z'),
    })

    const target = results.find((result) => result.component === 'analyzer:label_aggregate_refresh')
    expect(target?.activeCountBefore).toBe(1)
    expect(target?.activeCountAfter).toBe(0)

    const remaining = await prisma.operationalIssue.findMany({
      where: { component: 'analyzer:label_aggregate_refresh', status: 'active' },
    })
    expect(remaining).toHaveLength(1)
  })

  it('対象 issue が存在しない状態で apply: true を呼んでも例外にならない', async () => {
    await expect(
      cleanupDeprecatedWorkItemKindIssues(prisma, {
        apply: true,
        now: new Date(),
        before: new Date(),
      }),
    ).resolves.not.toThrow()
  })
})
