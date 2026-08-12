import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getPrismaClient } from '../db/client'
import {
  detectAnalysisStageFailure,
  detectRunFailures,
  detectStalledBlockOutboxEntries,
} from './detect-run-failures'
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

  it('後続の completed run が同じ component の過去 run_failure を resolved にする', async () => {
    const failedRunId = `block-${randomUUID()}`
    const completedRunId = `block-${randomUUID()}`
    const failedAt = new Date('2026-08-09T00:00:00Z')
    const recoveredAt = new Date('2026-08-09T01:00:00Z')

    await detectRunFailures(prisma, {
      component: 'block',
      runId: failedRunId,
      runStatus: 'failed',
      errorSummary: 'interrupted',
      now: failedAt,
    })
    const issue = await prisma.operationalIssue.findFirstOrThrow({
      where: { component: 'block', type: 'run_failure' },
    })

    await detectRunFailures(prisma, {
      component: 'block',
      runId: completedRunId,
      runStatus: 'completed',
      errorSummary: null,
      now: recoveredAt,
    })

    const resolved = await prisma.operationalIssue.findUniqueOrThrow({ where: { id: issue.id } })
    expect(resolved.status).toBe('resolved')
    expect(resolved.resolvedAt).toEqual(recoveredAt)
    const occurrences = await prisma.operationalIssueOccurrence.findMany({
      where: { issueId: issue.id, stateTransition: 'resolved' },
    })
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]?.sourceId).toBe(completedRunId)
  })

  it('running run は過去 run_failure を resolved にしない', async () => {
    const failedRunId = `crawl-${randomUUID()}`
    await detectRunFailures(prisma, {
      component: 'crawl',
      runId: failedRunId,
      runStatus: 'failed',
      errorSummary: 'boom',
      now: new Date('2026-08-09T00:00:00Z'),
    })

    await detectRunFailures(prisma, {
      component: 'crawl',
      runId: `crawl-${randomUUID()}`,
      runStatus: 'running',
      errorSummary: null,
      now: new Date('2026-08-09T01:00:00Z'),
    })

    const issue = await prisma.operationalIssue.findFirstOrThrow({
      where: { component: 'crawl', type: 'run_failure' },
    })
    expect(issue.status).toBe('active')
  })

  it('supersedeCutoff より後に検出された active issue は resolve しない', async () => {
    const oldFailedRunId = `crawl-${randomUUID()}`
    const newFailedRunId = `crawl-${randomUUID()}`
    const recoveredRunId = `crawl-${randomUUID()}`

    // 古い failure (cutoff より前)
    await detectRunFailures(prisma, {
      component: 'crawl',
      runId: oldFailedRunId,
      runStatus: 'failed',
      errorSummary: 'boom',
      now: new Date('2026-08-09T00:00:00Z'),
    })
    // 新しい failure (cutoff より後)
    await detectRunFailures(prisma, {
      component: 'crawl',
      runId: newFailedRunId,
      runStatus: 'failed',
      errorSummary: 'boom',
      now: new Date('2026-08-09T02:00:00Z'),
      observationKey: newFailedRunId,
    })

    // cutoff は古い failure の直後、新しい failure より前の時刻
    await detectRunFailures(prisma, {
      component: 'crawl',
      runId: recoveredRunId,
      runStatus: 'succeeded',
      errorSummary: null,
      now: new Date('2026-08-09T03:00:00Z'),
      supersedeCutoff: new Date('2026-08-09T01:00:00Z'),
    })

    const issues = await prisma.operationalIssue.findMany({
      where: { component: 'crawl', type: 'run_failure' },
      orderBy: { firstDetectedAt: 'asc' },
    })
    expect(issues).toHaveLength(2)
    expect(issues[0]?.status).toBe('resolved')
    expect(issues[1]?.status).toBe('active')
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

  it('transient failure の後に同じ WorkItem が成功すると active な issue を resolved にする', async () => {
    const workItemId = `work-item-${randomUUID()}`
    await detectAnalysisStageFailure(prisma, {
      kind: 'read_model_refresh',
      workItemId,
      attemptNumber: 1,
      status: 'failed',
      errorSummary: 'boom',
      now: new Date(),
    })
    const issueAfterFailure = await prisma.operationalIssue.findFirstOrThrow()
    expect(issueAfterFailure.status).toBe('active')

    await detectAnalysisStageFailure(prisma, {
      kind: 'read_model_refresh',
      workItemId,
      attemptNumber: 2,
      status: 'succeeded',
      errorSummary: undefined,
      now: new Date(),
    })

    const issueAfterSuccess = await prisma.operationalIssue.findUniqueOrThrow({
      where: { id: issueAfterFailure.id },
    })
    expect(issueAfterSuccess.status).toBe('resolved')
    expect(issueAfterSuccess.resolvedAt).not.toBeNull()
  })

  it('成功通知を retry しても resolution の Occurrence を重複作成しない', async () => {
    const workItemId = `work-item-${randomUUID()}`
    await detectAnalysisStageFailure(prisma, {
      kind: 'read_model_refresh',
      workItemId,
      attemptNumber: 1,
      status: 'failed',
      errorSummary: 'boom',
      now: new Date(),
    })
    const issue = await prisma.operationalIssue.findFirstOrThrow()

    for (let i = 0; i < 2; i++) {
      await detectAnalysisStageFailure(prisma, {
        kind: 'read_model_refresh',
        workItemId,
        attemptNumber: 2,
        status: 'succeeded',
        errorSummary: undefined,
        now: new Date(),
      })
    }

    const occurrences = await prisma.operationalIssueOccurrence.findMany({
      where: { issueId: issue.id, stateTransition: 'resolved' },
    })
    expect(occurrences).toHaveLength(1)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('detectStalledBlockOutboxEntries', () => {
  const prisma = getPrismaClient()
  const staleCreatedAt = new Date(Date.now() - 60 * 60 * 1000)

  async function resetDb(): Promise<void> {
    await prisma.blockOutboxEntry.deleteMany()
    await prisma.blockAccountRun.deleteMany()
    await prisma.blockRun.deleteMany()
    await prisma.account.deleteMany()
    await prisma.labelDefinition.deleteMany()
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
  }

  beforeEach(resetDb)
  afterAll(resetDb)

  /**
   * @param count - 作成する停滞済み (createdAt が古い) outbox entry の件数
   */
  async function createStalledOutboxEntries(count: number): Promise<void> {
    const blockerId = `blocker-${randomUUID()}`
    await prisma.account.create({
      data: {
        id: blockerId,
        screenName: 'alice',
        displayName: 'Alice',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `spam-${randomUUID()}`, description: '架空のテスト用ラベル' },
    })
    const blockRun = await prisma.blockRun.create({
      data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
    })
    const accountRun = await prisma.blockAccountRun.create({
      data: {
        blockRunId: blockRun.id,
        username: 'alice',
        startedAt: new Date(),
        status: 'running',
      },
    })

    for (let i = 0; i < count; i++) {
      const blockedId = `blocked-${randomUUID()}`
      await prisma.account.create({
        data: {
          id: blockedId,
          screenName: `bob-${i}`,
          displayName: 'Bob',
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
        },
      })
      const entry = await prisma.blockOutboxEntry.create({
        data: {
          blockAccountRunId: accountRun.id,
          blockerId,
          blockedId,
          labelDefinitionId: labelDefinition.id,
          confidence: 0.9,
          status: 'pending_remote',
        },
      })
      await prisma.blockOutboxEntry.update({
        where: { id: entry.id },
        data: { createdAt: staleCreatedAt },
      })
    }
  }

  it('停滞件数が閾値を超えると active な OperationalIssue を作る', async () => {
    await createStalledOutboxEntries(5)

    await detectStalledBlockOutboxEntries(prisma, new Date())

    const issues = await prisma.operationalIssue.findMany({
      where: { component: 'block', type: 'outbox_stalled' },
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.status).toBe('active')
  })

  it('停滞件数が閾値未満なら OperationalIssue を作らない', async () => {
    await createStalledOutboxEntries(1)

    await detectStalledBlockOutboxEntries(prisma, new Date())

    const issues = await prisma.operationalIssue.findMany({
      where: { component: 'block', type: 'outbox_stalled' },
    })
    expect(issues).toHaveLength(0)
  })

  it('停滞が解消されると active な OperationalIssue を resolved にし resolved Occurrence を記録する', async () => {
    await createStalledOutboxEntries(5)
    await detectStalledBlockOutboxEntries(prisma, new Date())
    await prisma.blockOutboxEntry.updateMany({ data: { status: 'local_persisted' } })

    await detectStalledBlockOutboxEntries(prisma, new Date())

    const issues = await prisma.operationalIssue.findMany({
      where: { component: 'block', type: 'outbox_stalled' },
    })
    expect(issues[0]?.status).toBe('resolved')

    const occurrences = await prisma.operationalIssueOccurrence.findMany({
      where: { issueId: issues[0]?.id, stateTransition: 'resolved' },
    })
    expect(occurrences).toHaveLength(1)
  })
})
