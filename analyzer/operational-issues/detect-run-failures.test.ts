import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import { detectAnalysisStageFailure, detectRunFailures } from './detect-run-failures'
import { randomUUID } from 'node:crypto'

describe.skipIf(!process.env.DATABASE_URL)('detectRunFailures', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
  })

  it('failed な run から OperationalIssue が 1 件作られる', async () => {
    const runId = `crawl-${randomUUID()}`
    await detectRunFailures(prisma, {
      component: 'crawl',
      runId,
      runStatus: 'failed',
      errorSummary: 'timeout',
      now: new Date(),
    })

    const issues = await prisma.operationalIssue.findMany({
      where: { component: 'crawl', type: 'run_failure' },
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.status).toBe('active')
  })

  it('同じ run を 2 回処理しても Occurrence が重複しない', async () => {
    const runId = `crawl-${randomUUID()}`
    await detectRunFailures(prisma, {
      component: 'crawl',
      runId,
      runStatus: 'failed',
      errorSummary: 'timeout',
      now: new Date(),
    })
    await detectRunFailures(prisma, {
      component: 'crawl',
      runId,
      runStatus: 'failed',
      errorSummary: 'timeout',
      now: new Date(),
    })

    const issues = await prisma.operationalIssue.findMany({
      where: { component: 'crawl', type: 'run_failure' },
    })
    expect(issues).toHaveLength(1)

    const occurrences = await prisma.operationalIssueOccurrence.findMany({
      where: { issueId: issues[0]?.id },
    })
    expect(occurrences).toHaveLength(1)
  })

  it('succeeded な run では OperationalIssue を作らない', async () => {
    const runId = `crawl-${randomUUID()}`
    await detectRunFailures(prisma, {
      component: 'crawl',
      runId,
      runStatus: 'success',
      errorSummary: null,
      now: new Date(),
    })

    const issues = await prisma.operationalIssue.findMany({
      where: { component: 'crawl', type: 'run_failure' },
    })
    expect(issues).toHaveLength(0)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('detectAnalysisStageFailure', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
  })

  it('dead な WorkItem から critical の OperationalIssue を作る', async () => {
    const workItemId = `work-item-${randomUUID()}`
    await detectAnalysisStageFailure(prisma, {
      kind: 'label_metrics',
      workItemId,
      attemptNumber: 5,
      status: 'dead',
      errorSummary: 'boom',
      now: new Date(),
    })

    const issues = await prisma.operationalIssue.findMany()
    expect(issues).toHaveLength(1)
    expect(issues[0]?.component).toBe('analyzer:label_metrics')
    expect(issues[0]?.severity).toBe('critical')
  })

  it('succeeded では OperationalIssue を作らない', async () => {
    await detectAnalysisStageFailure(prisma, {
      kind: 'label_metrics',
      workItemId: `work-item-${randomUUID()}`,
      attemptNumber: 1,
      status: 'succeeded',
      errorSummary: undefined,
      now: new Date(),
    })

    const issues = await prisma.operationalIssue.findMany()
    expect(issues).toHaveLength(0)
  })

  it('試行ごとに Occurrence を残す', async () => {
    const workItemId = `work-item-${randomUUID()}`
    for (const attemptNumber of [1, 2]) {
      await detectAnalysisStageFailure(prisma, {
        kind: 'read_model_refresh',
        workItemId,
        attemptNumber,
        status: 'failed',
        errorSummary: 'boom',
        now: new Date(),
      })
    }

    const issue = await prisma.operationalIssue.findFirstOrThrow()
    const occurrences = await prisma.operationalIssueOccurrence.findMany({
      where: { issueId: issue.id },
    })
    expect(occurrences).toHaveLength(2)
  })
})
