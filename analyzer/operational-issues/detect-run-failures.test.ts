import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import { detectRunFailures } from './detect-run-failures'
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
