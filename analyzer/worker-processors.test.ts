import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Logger } from '@book000/node-utils'
import { getPrismaClient } from './db/client'
import { detectAnalysisStageFailure } from './operational-issues/detect-run-failures'
import * as labelMetricSnapshotModule from './metrics/label-metric-snapshot'
import * as publishModule from './read-models/publish'
import {
  processReadModelRefresh,
  processLabelAggregateRefresh,
  processBlockReconciliation,
  processRetentionSweep,
  processOperationCycleRefresh,
  handleWorkItemSettled,
  processPostCompletionRefresh,
  processAccountSummaryRefresh,
  processAccountFindingRefresh,
} from './worker-processors'

const prisma = getPrismaClient()

/**
 * @param overrides - AnalysisWorkItem へ上書きするフィールド
 * @returns テスト用の operation_cycle_refresh WorkItem
 */
function makeCycleRefreshWorkItem(overrides: {
  triggerType: string
  triggerId: string
}): Parameters<typeof processOperationCycleRefresh>[1] {
  return {
    id: 'work-item-cycle-refresh',
    kind: 'operation_cycle_refresh',
    triggerType: overrides.triggerType,
    triggerId: overrides.triggerId,
    status: 'leased',
    priority: 0,
    availableAt: new Date(),
    leaseOwner: 'worker-1',
    leaseExpiresAt: new Date(),
    attemptCount: 1,
    maxAttempts: 5,
    dependencyKey: null,
    staleRequestedAt: null,
    lastErrorCode: null,
    lastErrorSummary: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

/**
 * @param overrides - AnalysisWorkItem へ上書きするフィールド
 * @returns テスト用の完了済み WorkItem
 */
function makeSettledWorkItem(overrides: {
  triggerType: string
}): Parameters<typeof handleWorkItemSettled>[1] {
  return {
    id: `work-item-${randomUUID()}`,
    kind: 'read_model_refresh',
    triggerType: overrides.triggerType,
    triggerId: 'trigger-1',
    status: 'succeeded',
    priority: 0,
    availableAt: new Date(),
    leaseOwner: null,
    leaseExpiresAt: null,
    attemptCount: 1,
    maxAttempts: 5,
    dependencyKey: null,
    staleRequestedAt: null,
    lastErrorCode: null,
    lastErrorSummary: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

describe.skipIf(!process.env.DATABASE_URL)('worker-processors', () => {
  beforeEach(async () => {
    await prisma.operationStage.deleteMany()
    await prisma.operationCycle.deleteMany()
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.attentionItemCurrent.deleteMany()
    await prisma.overviewSnapshot.deleteMany()
    await prisma.blockRelationCurrent.deleteMany()
    await prisma.readModelState.deleteMany()
    await prisma.readModelPointer.deleteMany()
    await prisma.readModelGeneration.deleteMany()
    await prisma.labelMetricSnapshot.deleteMany()
    await prisma.crawlAccountLabelRun.deleteMany()
    await prisma.crawlRun.deleteMany()
    await prisma.blockAccountRun.deleteMany()
    await prisma.blockRun.deleteMany()
    await prisma.weeklyAnalysisRun.deleteMany()
  })

  it('processReadModelRefresh は CrawlRun の状態によらず Attention/Overview を publish する', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'partial',
      },
    })

    await processReadModelRefresh(prisma, {
      id: 'work-item-3',
      kind: 'read_model_refresh',
      triggerType: 'crawl_run',
      triggerId: crawlRun.id,
      status: 'leased',
      priority: 0,
      availableAt: new Date(),
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(),
      attemptCount: 1,
      maxAttempts: 5,
      dependencyKey: null,
      staleRequestedAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const attentionPointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'attention_items' },
    })
    const overviewPointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'overview_snapshot' },
    })
    expect(attentionPointer).not.toBeNull()
    expect(overviewPointer).not.toBeNull()
  })

  it('processBlockReconciliation は block_relation の ReadModelPointer を current に切り替える', async () => {
    const blockRun = await prisma.blockRun.create({
      data: {
        id: `block-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })

    await processBlockReconciliation(prisma, {
      id: 'work-item-3',
      kind: 'block_reconciliation',
      triggerType: 'block_run',
      triggerId: blockRun.id,
      status: 'leased',
      priority: 0,
      availableAt: new Date(),
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(),
      attemptCount: 1,
      maxAttempts: 5,
      dependencyKey: null,
      staleRequestedAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const pointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'block_relation' },
    })
    expect(pointer).not.toBeNull()

    const attentionPointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'attention_items' },
    })
    expect(attentionPointer).not.toBeNull()
    const overviewPointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'overview_snapshot' },
    })
    expect(overviewPointer).not.toBeNull()
  })

  it('processRetentionSweep は次回分の WorkItem を即時 claim 可能な状態で enqueue しない', async () => {
    await processRetentionSweep(prisma, {
      id: 'work-item-4',
      kind: 'retention_sweep',
      triggerType: 'schedule',
      triggerId: '2026-01-01',
      status: 'leased',
      priority: 0,
      availableAt: new Date(),
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(),
      attemptCount: 1,
      maxAttempts: 5,
      dependencyKey: null,
      staleRequestedAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const pending = await prisma.analysisWorkItem.findMany({
      where: { kind: 'retention_sweep' },
    })
    expect(pending).toHaveLength(0)
  })

  it('handleWorkItemSettled は Cycle 再構築後に Attention/Overview を改めて publish する', async () => {
    await handleWorkItemSettled(
      prisma,
      {
        id: 'work-item-5',
        kind: 'read_model_refresh',
        triggerType: 'unhandled_trigger_type',
        triggerId: 'trigger-1',
        status: 'succeeded',
        priority: 0,
        availableAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        attemptCount: 1,
        maxAttempts: 5,
        dependencyKey: null,
        staleRequestedAt: null,
        lastErrorCode: null,
        lastErrorSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      { status: 'succeeded' },
    )

    const attentionPointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'attention_items' },
    })
    const overviewPointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'overview_snapshot' },
    })
    expect(attentionPointer).not.toBeNull()
    expect(overviewPointer).not.toBeNull()
  })

  it('handleWorkItemSettled は OperationCycle を持たない既知の triggerType では WARN を出さない', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn')

    await handleWorkItemSettled(
      prisma,
      makeSettledWorkItem({ triggerType: 'account_classification_observation' }),
      { status: 'succeeded' },
    )

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('handleWorkItemSettled は未知の triggerType では WARN を出す', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn')

    await handleWorkItemSettled(prisma, makeSettledWorkItem({ triggerType: 'unknown_trigger' }), {
      status: 'succeeded',
    })

    expect(warnSpy).toHaveBeenCalledWith(
      'no operation cycle builder for trigger type: unknown_trigger',
    )
    warnSpy.mockRestore()
  })

  it('processPostCompletionRefresh は元 WorkItem の終了状態を復元して Attention/Overview を publish する', async () => {
    const originalWorkItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'read_model_refresh',
        triggerType: 'unhandled_trigger_type',
        triggerId: `trigger-${randomUUID()}`,
        status: 'succeeded',
      },
    })

    await processPostCompletionRefresh(prisma, {
      id: `post-completion-refresh-${randomUUID()}`,
      kind: 'post_completion_refresh',
      triggerType: 'work_item_completion',
      triggerId: originalWorkItem.id,
      status: 'succeeded',
      priority: 0,
      availableAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      maxAttempts: 5,
      dependencyKey: null,
      staleRequestedAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const attentionPointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'attention_items' },
    })
    const overviewPointer = await prisma.readModelPointer.findUnique({
      where: { modelKey: 'overview_snapshot' },
    })
    expect(attentionPointer).not.toBeNull()
    expect(overviewPointer).not.toBeNull()
  })

  it('processPostCompletionRefresh は元 WorkItem の lastErrorCode も復元し、generic issue を新規作成しない', async () => {
    const workItemId = `work-item-${randomUUID()}`
    await detectAnalysisStageFailure(prisma, {
      kind: 'label_aggregate_refresh',
      workItemId,
      attemptNumber: 1,
      status: 'dead',
      errorSummary: 'transaction timeout',
      errorCode: 'label_aggregate_snapshot_failed',
      triggerType: 'schedule',
      createdAt: new Date(),
      now: new Date(),
    })
    const issue = await prisma.operationalIssue.findFirstOrThrow()
    expect(issue.component).toBe('analyzer:label_aggregate_refresh:snapshot')

    // handleWorkItemSettled の post-completion hook が一度失敗し、durable retry として post_completion_refresh 経由で同じ元 WorkItem を再処理する状況を再現する。
    const originalWorkItem = await prisma.analysisWorkItem.create({
      data: {
        id: workItemId,
        kind: 'label_aggregate_refresh',
        triggerType: 'schedule',
        triggerId: `trigger-${randomUUID()}`,
        status: 'dead',
        attemptCount: 1,
        lastErrorCode: 'label_aggregate_snapshot_failed',
        lastErrorSummary: 'transaction timeout',
      },
    })

    await processPostCompletionRefresh(prisma, {
      id: `post-completion-refresh-${randomUUID()}`,
      kind: 'post_completion_refresh',
      triggerType: 'work_item_completion',
      triggerId: originalWorkItem.id,
      status: 'succeeded',
      priority: 0,
      availableAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      maxAttempts: 5,
      dependencyKey: null,
      staleRequestedAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const activeIssues = await prisma.operationalIssue.findMany({ where: { status: 'active' } })
    expect(activeIssues).toHaveLength(1)
    expect(activeIssues[0]?.component).toBe('analyzer:label_aggregate_refresh:snapshot')
  })

  describe('processOperationCycleRefresh', () => {
    it('triggerType が crawl_run なら対象 CrawlRun の実在確認だけで完了する', async () => {
      const crawlRun = await prisma.crawlRun.create({
        data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
      })

      await expect(
        processOperationCycleRefresh(
          prisma,
          makeCycleRefreshWorkItem({ triggerType: 'crawl_run', triggerId: crawlRun.id }),
        ),
      ).resolves.toBeUndefined()
    })

    it('triggerType が block_run なら対象 BlockRun の実在確認だけで完了する', async () => {
      const blockRun = await prisma.blockRun.create({
        data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
      })

      await expect(
        processOperationCycleRefresh(
          prisma,
          makeCycleRefreshWorkItem({ triggerType: 'block_run', triggerId: blockRun.id }),
        ),
      ).resolves.toBeUndefined()
    })

    it('triggerType が weekly_analysis_run なら対象 WeeklyAnalysisRun の実在確認だけで完了する', async () => {
      const weeklyAnalysisRun = await prisma.weeklyAnalysisRun.create({
        data: {
          startedAt: new Date(),
          lastHeartbeatAt: new Date(),
          status: 'running',
          sampledAccountIds: [],
        },
      })

      await expect(
        processOperationCycleRefresh(
          prisma,
          makeCycleRefreshWorkItem({
            triggerType: 'weekly_analysis_run',
            triggerId: weeklyAnalysisRun.id,
          }),
        ),
      ).resolves.toBeUndefined()
    })

    it('未知の triggerType なら例外を投げる', async () => {
      await expect(
        processOperationCycleRefresh(
          prisma,
          makeCycleRefreshWorkItem({ triggerType: 'unknown', triggerId: 'x' }),
        ),
      ).rejects.toThrow('unsupported trigger type for operation_cycle_refresh: unknown')
    })
  })
})

describe.skipIf(!process.env.DATABASE_URL)('processAccountSummaryRefresh', () => {
  beforeEach(async () => {
    await prisma.accountClassificationLatest.deleteMany()
    await prisma.accountSummaryLatest.deleteMany()
    await prisma.accountLabelChange.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.accountClassificationObservation.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.readModelState.deleteMany()
    await prisma.labelDefinition.deleteMany()
    await prisma.block.deleteMany()
    await prisma.account.deleteMany()
  })

  it('uses Account.lastCrawledAt (not the observation time) as profileObservedAt, detects a same-count label-set change, records AccountLabelChange, and marks account_summary_latest healthy', async () => {
    const lastCrawledAt = new Date('2026-01-03T00:00:00Z')
    const account = await prisma.account.create({
      data: {
        id: 'acct_refresh',
        screenName: 'dave',
        displayName: 'Dave',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt,
      },
    })
    const labelA = await prisma.labelDefinition.create({
      data: { key: 'label_a', description: 'ラベルA' },
    })
    const labelB = await prisma.labelDefinition.create({
      data: { key: 'label_b', description: 'ラベルB' },
    })
    // 直前は label_a のみ true (1 件)。今回は label_a が false、label_b が true になる
    // (件数は 1 件のまま変わらないが、ラベルの中身は入れ替わっている)。
    await prisma.accountLabel.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelA.id,
        value: true,
        confidence: 0.9,
        reason: 'previous reason',
        method: 'rule',
        ruleVersion: 'v1',
        labeledAt: new Date('2026-01-01T00:00:00Z'),
      },
    })
    const observedAt = new Date('2026-01-02T00:00:00Z')
    await prisma.accountLabel.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelA.id,
        value: false,
        confidence: 0.2,
        reason: 'new reason a',
        method: 'rule',
        ruleVersion: 'v1',
        labeledAt: observedAt,
      },
    })
    await prisma.accountLabel.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelB.id,
        value: true,
        confidence: 0.8,
        reason: 'new reason b',
        method: 'rule',
        ruleVersion: 'v1',
        labeledAt: observedAt,
      },
    })
    const observation = await prisma.accountClassificationObservation.create({
      data: { accountId: account.id, observedAt, labelCount: 2 },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_refresh',
        triggerType: 'account_classification_observation',
        triggerId: observation.id,
      },
    })

    const originalTransaction = prisma.$transaction.bind(prisma)
    let transactionOptions: unknown
    prisma.$transaction = ((callback: unknown, options: unknown) => {
      transactionOptions = options
      return originalTransaction(callback as never, options as never)
    }) as typeof prisma.$transaction
    try {
      await processAccountSummaryRefresh(prisma, workItem)
    } finally {
      prisma.$transaction = originalTransaction
    }

    expect(transactionOptions).toEqual({ timeout: 60_000 })

    const summary = await prisma.accountSummaryLatest.findUnique({
      where: { accountId: account.id },
    })
    expect(summary?.activeLabelKeys).toEqual(['label_b'])
    expect(summary?.profileObservedAt.toISOString()).toBe(lastCrawledAt.toISOString())
    expect(summary?.lastClassificationChangedAt?.toISOString()).toBe(observedAt.toISOString())

    const changes = await prisma.accountLabelChange.findMany({
      where: { accountId: account.id },
      orderBy: { labelDefinitionId: 'asc' },
    })
    expect(changes).toHaveLength(2)
    expect(changes.find((c) => c.labelDefinitionId === labelA.id)?.changeType).toBe('removed')
    expect(changes.find((c) => c.labelDefinitionId === labelB.id)?.changeType).toBe('added')

    const state = await prisma.readModelState.findUnique({
      where: { modelKey: 'account_summary_latest' },
    })
    expect(state?.status).toBe('healthy')
    expect(state?.sourceWatermarkAt?.toISOString()).toBe(observedAt.toISOString())
  })

  it('leaves classificationObservedAt unset when the watermark has no AccountLabel rows, keeping it in sync with AccountClassificationLatest having no rows', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_pop_1',
        screenName: 'alice',
        displayName: 'Alice',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date('2026-01-03T00:00:00Z'),
      },
    })
    const observedAt = new Date('2026-01-02T00:00:00Z')
    const observation = await prisma.accountClassificationObservation.create({
      data: { accountId: account.id, observedAt, labelCount: 0 },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_refresh',
        triggerType: 'account_classification_observation',
        triggerId: observation.id,
      },
    })

    await processAccountSummaryRefresh(prisma, workItem)

    const summary = await prisma.accountSummaryLatest.findUnique({
      where: { accountId: account.id },
    })
    expect(summary?.classificationObservedAt).toBeNull()
    const classificationRows = await prisma.accountClassificationLatest.findMany({
      where: { accountId: account.id },
    })
    expect(classificationRows).toHaveLength(0)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('processAccountFindingRefresh', () => {
  beforeEach(async () => {
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
    await prisma.accountClassificationLatest.deleteMany()
    await prisma.accountSummaryLatest.deleteMany()
    await prisma.accountLabelChange.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.accountClassificationObservation.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.readModelState.deleteMany()
    await prisma.labelDefinition.deleteMany()
    await prisma.block.deleteMany()
    await prisma.account.deleteMany()
  })

  it('updates only the finding fields, preserving existing profile/classification fields, and marks account_summary_latest healthy', async () => {
    const lastCrawledAt = new Date('2026-01-03T00:00:00Z')
    const account = await prisma.account.create({
      data: {
        id: 'acct_finding_refresh',
        screenName: 'erin',
        displayName: 'Erin',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt,
      },
    })
    const priorClassificationObservedAt = new Date('2026-01-02T00:00:00Z')
    await prisma.accountSummaryLatest.create({
      data: {
        accountId: account.id,
        normalizedScreenName: 'erin',
        normalizedDisplayName: 'erin',
        searchDocument: 'erin erin',
        profileObservedAt: lastCrawledAt,
        activeLabelKeys: ['label_a'],
        activeLabelCount: 1,
        classificationObservedAt: priorClassificationObservedAt,
        activeFindingCount: 0,
        highestFindingSeverity: null,
        findingObservedAt: null,
      },
    })

    const finding = await prisma.reviewFinding.create({
      data: {
        fingerprint: `fingerprint-${randomUUID()}`,
        identityVersion: 1,
        type: 'label_count_drop',
        primaryScopeType: 'account',
        primaryScopeId: account.id,
        status: 'active',
        currentSeverity: 'high',
        maximumSeverity: 'high',
      },
    })
    const sourceObservedAt = new Date('2026-01-04T00:00:00Z')
    const occurrence = await prisma.reviewFindingOccurrence.create({
      data: {
        findingId: finding.id,
        observedAt: sourceObservedAt,
        sourceObservedAt,
        stateTransition: 'active',
        severity: 'high',
        sourceType: 'label_metric',
        sourceId: 'crawl-1',
        policyHash: 'policy-1',
        detectorVersion: 'v1',
        observationKey: 'crawl-1',
      },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_refresh',
        triggerType: 'review_finding_occurrence',
        triggerId: occurrence.id,
      },
    })

    await processAccountFindingRefresh(prisma, workItem)

    const summary = await prisma.accountSummaryLatest.findUnique({
      where: { accountId: account.id },
    })
    expect(summary?.activeFindingCount).toBe(1)
    expect(summary?.highestFindingSeverity).toBe('high')
    expect(summary?.findingObservedAt?.toISOString()).toBe(sourceObservedAt.toISOString())
    // finding 系以外は既存値をそのまま維持する。
    expect(summary?.activeLabelKeys).toEqual(['label_a'])
    expect(summary?.classificationObservedAt?.toISOString()).toBe(
      priorClassificationObservedAt.toISOString(),
    )

    const state = await prisma.readModelState.findUnique({
      where: { modelKey: 'account_summary_latest' },
    })
    expect(state?.status).toBe('healthy')
    expect(state?.sourceWatermarkAt?.toISOString()).toBe(sourceObservedAt.toISOString())
  })

  it('does nothing when the Occurrence belongs to a non-account Finding', async () => {
    const finding = await prisma.reviewFinding.create({
      data: {
        fingerprint: `fingerprint-${randomUUID()}`,
        identityVersion: 1,
        type: 'label_count_drop',
        primaryScopeType: 'label',
        primaryScopeId: 'label-definition-1',
        status: 'active',
        currentSeverity: 'high',
        maximumSeverity: 'high',
      },
    })
    const sourceObservedAt = new Date('2026-01-04T00:00:00Z')
    const occurrence = await prisma.reviewFindingOccurrence.create({
      data: {
        findingId: finding.id,
        observedAt: sourceObservedAt,
        sourceObservedAt,
        stateTransition: 'active',
        severity: 'high',
        sourceType: 'label_metric',
        sourceId: 'crawl-1',
        policyHash: 'policy-1',
        detectorVersion: 'v1',
        observationKey: 'crawl-1',
      },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_refresh',
        triggerType: 'review_finding_occurrence',
        triggerId: occurrence.id,
      },
    })

    await expect(processAccountFindingRefresh(prisma, workItem)).resolves.toBeUndefined()

    const state = await prisma.readModelState.findUnique({
      where: { modelKey: 'account_summary_latest' },
    })
    expect(state).toBeNull()
  })
})

describe.skipIf(!process.env.DATABASE_URL)('processLabelAggregateRefresh', () => {
  beforeEach(async () => {
    await prisma.findingEvidence.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
    await prisma.detectorEvaluation.deleteMany()
    await prisma.labelSummaryCurrent.deleteMany()
    await prisma.labelMetricSnapshot.deleteMany()
    await prisma.accountClassificationLatest.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.readModelState.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.labelDefinition.deleteMany()
  })

  it('runs Finding evaluation only for triggerType crawl_run', async () => {
    await prisma.labelDefinition.create({
      data: { key: 'test_pipeline_label', description: 'ラベル' },
    })

    const scheduleWorkItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'label_aggregate_refresh',
        triggerType: 'schedule',
        triggerId: '2026-01-01T00',
      },
    })
    await processLabelAggregateRefresh(prisma, scheduleWorkItem)
    const evaluationsAfterSchedule = await prisma.detectorEvaluation.count()
    expect(evaluationsAfterSchedule).toBe(0)

    const summaryAfterSchedule = await prisma.labelSummaryCurrent.findMany()
    expect(summaryAfterSchedule.length).toBeGreaterThan(0)

    // buildLabelAggregateSnapshotSet が必須の freshnessThresholdsMs を実際に受け取って
    // 動作したことを、currentCount/delayedCount/staleCount が evaluatedCount に一致する
    // (集計が空でない) ことで確認する。
    const snapshot = await prisma.labelMetricSnapshot.findFirstOrThrow({
      where: { triggerWorkItemId: scheduleWorkItem.id },
    })
    expect(snapshot.currentCount + snapshot.delayedCount + snapshot.staleCount).toBe(
      snapshot.evaluatedCount,
    )
  })
})

describe('processLabelAggregateRefresh のエラーコード分岐', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('buildLabelAggregateSnapshotSet が失敗すると label_aggregate_snapshot_failed を投げる', async () => {
    vi.spyOn(labelMetricSnapshotModule, 'buildLabelAggregateSnapshotSet').mockRejectedValue(
      new Error('db error'),
    )

    await expect(
      processLabelAggregateRefresh(prisma, {
        id: 'wi-1',
        triggerType: 'crawl_run',
        triggerId: 'run-1',
      } as never),
    ).rejects.toMatchObject({ errorCode: 'label_aggregate_snapshot_failed' })
  })

  it('publishGeneration が失敗すると label_summary_publish_failed を投げる', async () => {
    vi.spyOn(labelMetricSnapshotModule, 'buildLabelAggregateSnapshotSet').mockResolvedValue({
      triggerWorkItemId: 'wi-1',
      snapshotAt: new Date(),
      reused: false,
    })
    vi.spyOn(publishModule, 'publishGeneration').mockRejectedValue(new Error('publish error'))

    // triggerType を schedule にして Finding 評価 (crawl_run 限定) を経由させず、
    // publishGeneration 失敗だけを単独で検証する。
    await expect(
      processLabelAggregateRefresh(prisma, {
        id: 'wi-1',
        triggerType: 'schedule',
        triggerId: '2026-08-09T00',
      } as never),
    ).rejects.toMatchObject({ errorCode: 'label_summary_publish_failed' })
  })
})
