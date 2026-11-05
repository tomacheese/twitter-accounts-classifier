import { createSyntheticId } from 'id-boundary'
import { beforeEach, describe, expect, it } from 'vitest'
import { getPrismaClient } from '../db/client'
import { RETENTION_DAYS } from './config'
import { runRetentionSweep } from './sweep'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-08T00:00:00.000Z')
const FAST = { pauseMs: 0 }

/**
 * @param days - 遡る日数
 * @param offsetMs - 期限からのずれ (負で期限より前)
 */
function cutoff(days: number, offsetMs = 0): Date {
  return new Date(NOW.getTime() - days * DAY_MS + offsetMs)
}

const prisma = getPrismaClient()

async function seedExpiredDone(count: number): Promise<void> {
  const at = cutoff(RETENTION_DAYS.analysisWorkItemDone, -1)
  await prisma.analysisWorkItemDone.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      kind: 'k',
      triggerType: 't',
      triggerId: `batch-${index}`,
      workItemId: index,
      attemptCount: 1,
      createdAt: at,
      completedAt: at,
    })),
  })
}

async function createCrawlRun(finishedAt: Date | null, lastHeartbeatAt = NOW): Promise<string> {
  const run = await prisma.crawlRun.create({
    data: { startedAt: cutoff(400), lastHeartbeatAt, finishedAt, status: 'success' },
  })
  return run.id
}

describe.skipIf(!process.env.DATABASE_URL)('runRetentionSweep (実DB)', () => {
  let sequence = 0

  /** @returns テストごとに衝突しない文字列 */
  function tag(): string {
    sequence += 1
    return `t${sequence}-${createSyntheticId()}`
  }

  beforeEach(async () => {
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.analysisWorkItemDone.deleteMany()
    await prisma.labelSummaryCurrent.deleteMany()
    await prisma.labelMetricSnapshot.deleteMany()
    await prisma.overviewSnapshot.deleteMany()
    await prisma.readModelPointer.deleteMany()
    await prisma.detectorEvaluation.deleteMany()
    await prisma.accountClassificationObservation.deleteMany()
    await prisma.crawlAccountCheckpoint.deleteMany()
    await prisma.crawlAuthorCheckpoint.deleteMany()
    await prisma.crawlAccountLabelRun.deleteMany()
    await prisma.crawlRun.deleteMany()
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
  })

  async function createOperationalIssue(currentOccurrenceId?: string): Promise<string> {
    const issue = await prisma.operationalIssue.create({
      data: {
        component: 'test',
        type: 'test',
        fingerprint: tag(),
        severity: 'high',
        currentOccurrenceId,
      },
    })
    return issue.id
  }

  async function createOperationalOccurrence(issueId: string, observedAt: Date): Promise<string> {
    const occurrence = await prisma.operationalIssueOccurrence.create({
      data: {
        issueId,
        observedAt,
        stateTransition: 'activated',
        severity: 'high',
        sourceType: 'test',
        sourceId: 'test',
        observationKey: tag(),
      },
    })
    return occurrence.id
  }

  async function createFinding(): Promise<string> {
    const finding = await prisma.reviewFinding.create({
      data: {
        fingerprint: tag(),
        identityVersion: 1,
        type: 'test',
        primaryScopeType: 'test',
        primaryScopeId: 'test',
        currentSeverity: 'low',
        maximumSeverity: 'low',
      },
    })
    return finding.id
  }

  async function createFindingOccurrence(findingId: string, observedAt: Date): Promise<string> {
    const occurrence = await prisma.reviewFindingOccurrence.create({
      data: {
        findingId,
        observedAt,
        sourceObservedAt: observedAt,
        stateTransition: 'activated',
        severity: 'low',
        sourceType: 'test',
        sourceId: 'test',
        policyHash: 'test',
        detectorVersion: 'test',
        observationKey: tag(),
      },
    })
    return occurrence.id
  }

  /** 保持期限の境界を表ごとに検査するための定義。`at` の時刻の行を 1 件作る。 */
  const boundaryCases: {
    name: string
    days: number
    seed: (at: Date) => Promise<void>
    remaining: () => Promise<number>
  }[] = [
    {
      name: 'deadWorkItem',
      days: RETENTION_DAYS.deadWorkItem,
      seed: async (at) => {
        await prisma.analysisWorkItem.create({
          data: { kind: 'k', triggerType: 't', triggerId: tag(), status: 'dead', updatedAt: at },
        })
      },
      remaining: () => prisma.analysisWorkItem.count(),
    },
    {
      name: 'analysisWorkItemDone',
      days: RETENTION_DAYS.analysisWorkItemDone,
      seed: async (at) => {
        await prisma.analysisWorkItemDone.create({
          data: {
            kind: 'k',
            triggerType: 't',
            triggerId: tag(),
            workItemId: 1,
            attemptCount: 1,
            createdAt: at,
            completedAt: at,
          },
        })
      },
      remaining: () => prisma.analysisWorkItemDone.count(),
    },
    {
      name: 'analysisRun',
      days: RETENTION_DAYS.analysisRun,
      seed: async (at) => {
        await prisma.analysisRun.create({
          data: { attemptNumber: 1, status: 'succeeded', finishedAt: at },
        })
      },
      remaining: () => prisma.analysisRun.count(),
    },
    {
      name: 'labelMetricSnapshot',
      days: RETENTION_DAYS.labelMetricSnapshot,
      seed: async (at) => {
        sequence += 1
        await prisma.labelMetricSnapshot.create({
          data: {
            triggerWorkItemId: sequence,
            labelDefinitionId: 1,
            observedAt: at,
            sourceWatermarkAt: at,
            evaluatedCount: 0,
            trueCount: 0,
            prevalence: 0,
            completeness: 'complete',
            policyHash: 'test',
            analyzerVersion: 'test',
          },
        })
      },
      remaining: () => prisma.labelMetricSnapshot.count(),
    },
    {
      name: 'overviewSnapshot',
      days: RETENTION_DAYS.overviewSnapshot,
      seed: async (at) => {
        await prisma.overviewSnapshot.create({
          data: {
            generationId: tag(),
            schemaVersion: 1,
            generatedAt: at,
            sourceWatermarkAt: at,
            operationalStatus: 'ok',
            qualityStatus: 'ok',
            payload: {},
          },
        })
      },
      remaining: () => prisma.overviewSnapshot.count(),
    },
    {
      name: 'shadowDetectorEvaluation',
      days: RETENTION_DAYS.shadowDetectorEvaluation,
      seed: async (at) => {
        await prisma.detectorEvaluation.create({
          data: {
            detectorType: 'test',
            fingerprint: tag(),
            identityVersion: 1,
            sourceId: 'test',
            evaluatedAt: at,
            isShadow: true,
            result: {},
            policyHash: 'test',
          },
        })
      },
      remaining: () => prisma.detectorEvaluation.count(),
    },
    {
      name: 'accountClassificationObservation',
      days: RETENTION_DAYS.accountClassificationObservation,
      seed: async (at) => {
        await prisma.accountClassificationObservation.create({
          data: { accountId: createSyntheticId(), observedAt: at, labelCount: 0 },
        })
      },
      remaining: () => prisma.accountClassificationObservation.count(),
    },
    {
      name: 'crawlAccountCheckpoint',
      days: RETENTION_DAYS.crawlCheckpoint,
      seed: async (at) => {
        const crawlRunId = await createCrawlRun(at)
        await prisma.crawlAccountCheckpoint.create({
          data: { crawlRunId, username: 'alice', phase: 'profile', data: {} },
        })
      },
      remaining: () => prisma.crawlAccountCheckpoint.count(),
    },
    {
      name: 'crawlAuthorCheckpoint',
      days: RETENTION_DAYS.crawlCheckpoint,
      seed: async (at) => {
        const crawlRunId = await createCrawlRun(at)
        await prisma.crawlAuthorCheckpoint.create({
          data: { crawlRunId, username: 'alice', authorId: createSyntheticId(), status: 'success' },
        })
      },
      remaining: () => prisma.crawlAuthorCheckpoint.count(),
    },
    {
      name: 'crawlAccountLabelRun',
      days: RETENTION_DAYS.crawlCheckpoint,
      seed: async (at) => {
        const crawlRunId = await createCrawlRun(at)
        await prisma.crawlAccountLabelRun.create({
          data: {
            crawlRunId,
            username: 'alice',
            accountId: createSyntheticId(),
            labelDefinitionId: 1,
            method: 'rule',
            ruleVersion: '1',
          },
        })
      },
      remaining: () => prisma.crawlAccountLabelRun.count(),
    },
    {
      name: 'operationalIssueOccurrence',
      days: RETENTION_DAYS.operationalIssueOccurrence,
      seed: async (at) => {
        await createOperationalOccurrence(await createOperationalIssue(), at)
      },
      remaining: () => prisma.operationalIssueOccurrence.count(),
    },
    {
      name: 'reviewFindingOccurrence',
      days: RETENTION_DAYS.reviewFindingOccurrence,
      seed: async (at) => {
        await createFindingOccurrence(await createFinding(), at)
      },
      remaining: () => prisma.reviewFindingOccurrence.count(),
    },
  ]

  describe.each(boundaryCases)('$name', ({ name, days, seed, remaining }) => {
    it('期限ちょうどの行は残し、1ms でも前の行は削除する', async () => {
      await seed(cutoff(days))
      await seed(cutoff(days, -1))

      const result = await runRetentionSweep(prisma, NOW, FAST)

      expect(result.counts[name]).toBe(1)
      expect(await remaining()).toBe(1)
    })

    it('二度実行しても二度目は何も削除しない', async () => {
      await seed(cutoff(days, -1))

      await runRetentionSweep(prisma, NOW, FAST)
      const second = await runRetentionSweep(prisma, NOW, FAST)

      expect(second.counts[name]).toBe(0)
      expect(await remaining()).toBe(0)
    })
  })

  it('dead 以外のキュー行は期限を過ぎても削除しない', async () => {
    await prisma.analysisWorkItem.create({
      data: {
        kind: 'k',
        triggerType: 't',
        triggerId: tag(),
        status: 'queued',
        updatedAt: cutoff(400),
      },
    })

    await runRetentionSweep(prisma, NOW, FAST)

    expect(await prisma.analysisWorkItem.count()).toBe(1)
  })

  it('キューに残る WorkItem が参照する AnalysisRun は期限を過ぎても削除しない', async () => {
    const workItem = await prisma.analysisWorkItem.create({
      data: { kind: 'k', triggerType: 't', triggerId: tag(), status: 'queued' },
    })
    await prisma.analysisRun.create({
      data: {
        workItemId: workItem.id,
        attemptNumber: 1,
        status: 'failed',
        finishedAt: cutoff(RETENTION_DAYS.analysisRun + 1),
      },
    })

    await runRetentionSweep(prisma, NOW, FAST)

    expect(await prisma.analysisRun.count()).toBe(1)
  })

  it('終了していない AnalysisRun は削除しない', async () => {
    await prisma.analysisRun.create({ data: { attemptNumber: 1, status: 'running' } })

    await runRetentionSweep(prisma, NOW, FAST)

    expect(await prisma.analysisRun.count()).toBe(1)
  })

  it('公開中の世代の OverviewSnapshot は期限を過ぎても削除しない', async () => {
    const old = cutoff(RETENTION_DAYS.overviewSnapshot + 1)
    const base = {
      schemaVersion: 1,
      generatedAt: old,
      sourceWatermarkAt: old,
      operationalStatus: 'ok',
      qualityStatus: 'ok',
      payload: {},
    }
    await prisma.overviewSnapshot.create({ data: { ...base, generationId: 'current' } })
    await prisma.overviewSnapshot.create({ data: { ...base, generationId: 'previous' } })
    await prisma.readModelPointer.create({
      data: { modelKey: 'overview_snapshot', currentGenerationId: 'current' },
    })

    const result = await runRetentionSweep(prisma, NOW, FAST)

    expect(result.counts.overviewSnapshot).toBe(1)
    const rows = await prisma.overviewSnapshot.findMany()
    expect(rows.map((row) => row.generationId)).toEqual(['current'])
  })

  it('LabelSummaryCurrent が指す LabelMetricSnapshot は期限を過ぎても削除しない', async () => {
    const old = cutoff(RETENTION_DAYS.labelMetricSnapshot + 1)
    const base = {
      labelDefinitionId: 1,
      observedAt: old,
      sourceWatermarkAt: old,
      evaluatedCount: 0,
      trueCount: 0,
      prevalence: 0,
      completeness: 'complete',
      policyHash: 'test',
      analyzerVersion: 'test',
    }
    const referenced = await prisma.labelMetricSnapshot.create({
      data: { ...base, triggerWorkItemId: 1 },
    })
    await prisma.labelMetricSnapshot.create({ data: { ...base, triggerWorkItemId: 2 } })
    await prisma.labelSummaryCurrent.create({
      data: {
        generationId: 'g',
        labelDefinitionId: 1,
        latestSnapshotId: referenced.id,
        evaluatedCount: 0,
        trueCount: 0,
        prevalence: 0,
        qualityStatus: 'ok',
        sourceWatermarkAt: old,
      },
    })

    await runRetentionSweep(prisma, NOW, FAST)

    const rows = await prisma.labelMetricSnapshot.findMany()
    expect(rows.map((row) => row.id)).toEqual([referenced.id])
  })

  it('本番判定の DetectorEvaluation は期限を過ぎても削除しない', async () => {
    await prisma.detectorEvaluation.create({
      data: {
        detectorType: 'test',
        fingerprint: tag(),
        identityVersion: 1,
        sourceId: 'test',
        evaluatedAt: cutoff(400),
        isShadow: false,
        result: {},
        policyHash: 'test',
      },
    })

    await runRetentionSweep(prisma, NOW, FAST)

    expect(await prisma.detectorEvaluation.count()).toBe(1)
  })

  describe('AccountClassificationObservation', () => {
    const old = cutoff(RETENTION_DAYS.accountClassificationObservation + 1)

    it('終端でない account_summary_refresh WorkItem が参照する行は削除しない', async () => {
      const observation = await prisma.accountClassificationObservation.create({
        data: { accountId: createSyntheticId(), observedAt: old, labelCount: 0 },
      })
      await prisma.analysisWorkItem.create({
        data: {
          kind: 'account_summary_refresh',
          triggerType: 'account_classification_observation',
          triggerId: observation.id,
          status: 'queued',
        },
      })

      await runRetentionSweep(prisma, NOW, FAST)

      expect(await prisma.accountClassificationObservation.count()).toBe(1)
    })

    it('参照する WorkItem が dead のみの行は削除する', async () => {
      const observation = await prisma.accountClassificationObservation.create({
        data: { accountId: createSyntheticId(), observedAt: old, labelCount: 0 },
      })
      await prisma.analysisWorkItem.create({
        data: {
          kind: 'account_summary_refresh',
          triggerType: 'account_classification_observation',
          triggerId: observation.id,
          status: 'dead',
        },
      })

      await runRetentionSweep(prisma, NOW, FAST)

      expect(await prisma.accountClassificationObservation.count()).toBe(0)
    })
  })

  describe('crawl 系の Checkpoint', () => {
    it('実行中 (終了時刻なし、heartbeat が新しい) の Run の行は削除しない', async () => {
      const crawlRunId = await createCrawlRun(null, NOW)
      await prisma.crawlAccountCheckpoint.create({
        data: { crawlRunId, username: 'alice', phase: 'profile', data: {} },
      })

      await runRetentionSweep(prisma, NOW, FAST)

      expect(await prisma.crawlAccountCheckpoint.count()).toBe(1)
    })

    it('終了せずに止まった Run は、最後の heartbeat から期限を数えて削除する', async () => {
      const crawlRunId = await createCrawlRun(null, cutoff(RETENTION_DAYS.crawlCheckpoint, -1))
      await prisma.crawlAccountCheckpoint.create({
        data: { crawlRunId, username: 'alice', phase: 'profile', data: {} },
      })

      await runRetentionSweep(prisma, NOW, FAST)

      expect(await prisma.crawlAccountCheckpoint.count()).toBe(0)
    })
  })

  describe('Occurrence', () => {
    it('親が currentOccurrenceId で指す OperationalIssueOccurrence は期限を過ぎても削除しない', async () => {
      const issueId = await createOperationalIssue()
      const old = cutoff(RETENTION_DAYS.operationalIssueOccurrence + 1)
      const current = await createOperationalOccurrence(issueId, old)
      await createOperationalOccurrence(issueId, old)
      await prisma.operationalIssue.update({
        where: { id: issueId },
        data: { currentOccurrenceId: current },
      })

      await runRetentionSweep(prisma, NOW, FAST)

      const rows = await prisma.operationalIssueOccurrence.findMany()
      expect(rows.map((row) => row.id)).toEqual([current])
    })

    it('親が currentOccurrenceId で指す ReviewFindingOccurrence は期限を過ぎても削除しない', async () => {
      const findingId = await createFinding()
      const old = cutoff(RETENTION_DAYS.reviewFindingOccurrence + 1)
      const current = await createFindingOccurrence(findingId, old)
      await createFindingOccurrence(findingId, old)
      await prisma.reviewFinding.update({
        where: { id: findingId },
        data: { currentOccurrenceId: current },
      })

      await runRetentionSweep(prisma, NOW, FAST)

      const rows = await prisma.reviewFindingOccurrence.findMany()
      expect(rows.map((row) => row.id)).toEqual([current])
    })
  })

  describe('バッチ処理', () => {
    it('バッチ数の上限で打ち切り、残りは次回の実行で削除する', async () => {
      await seedExpiredDone(25)

      const first = await runRetentionSweep(prisma, NOW, {
        ...FAST,
        batchSize: 10,
        maxBatchesPerTable: 2,
      })
      expect(first.counts.analysisWorkItemDone).toBe(20)
      expect(first.truncatedTables).toEqual(['analysisWorkItemDone'])
      expect(await prisma.analysisWorkItemDone.count()).toBe(5)

      const second = await runRetentionSweep(prisma, NOW, { ...FAST, batchSize: 10 })
      expect(second.counts.analysisWorkItemDone).toBe(5)
      expect(second.truncatedTables).toEqual([])
      expect(await prisma.analysisWorkItemDone.count()).toBe(0)
    })

    it('対象がちょうど上限の行数でも、残りが無ければ打ち切り扱いにしない', async () => {
      await seedExpiredDone(20)

      const result = await runRetentionSweep(prisma, NOW, {
        ...FAST,
        batchSize: 10,
        maxBatchesPerTable: 3,
      })

      expect(result.counts.analysisWorkItemDone).toBe(20)
      expect(result.truncatedTables).toEqual([])
    })

    it('dry-run は削除せず、削除対象の行数だけを返す', async () => {
      await seedExpiredDone(25)

      const result = await runRetentionSweep(prisma, NOW, { ...FAST, dryRun: true })

      expect(result.counts.analysisWorkItemDone).toBe(25)
      expect(await prisma.analysisWorkItemDone.count()).toBe(25)
    })
  })
})
