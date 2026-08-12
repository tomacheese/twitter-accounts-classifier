import type { PrismaClient } from '../generated/prisma'
import {
  applyUpstreamBlocking,
  deriveWorkItemStage,
  upsertCycleWithStages,
  type CycleStageInput,
  type StageStatus,
} from './cycle-common'

/**
 * @param runStatus - WeeklyAnalysisRun.status の値
 * @returns weekly_review Stage の状態
 */
function deriveWeeklyReviewStageStatus(runStatus: string): StageStatus {
  if (runStatus === 'running') return 'running'
  if (runStatus === 'success' || runStatus === 'partial') return 'succeeded'
  if (runStatus === 'failed' || runStatus === 'timeout') return 'failed'
  return 'unknown'
}

/**
 * buildOrUpdateWeeklyReviewCycle の入力。
 */
export interface BuildOrUpdateWeeklyReviewCycleInput {
  /** 起点となる WeeklyAnalysisRun の ID。 */
  weeklyAnalysisRunId: string
}

/**
 * WeeklyAnalysisRun 1 件を起点に Cycle と 2 Stage を upsert する。
 * @param prisma - Prisma クライアント
 * @param input - 対象 WeeklyAnalysisRun
 */
export async function buildOrUpdateWeeklyReviewCycle(
  prisma: PrismaClient,
  input: BuildOrUpdateWeeklyReviewCycleInput,
): Promise<void> {
  const run = await prisma.weeklyAnalysisRun.findUniqueOrThrow({
    where: { id: input.weeklyAnalysisRunId },
  })

  const weeklyReviewStageStatus = deriveWeeklyReviewStageStatus(run.status)
  const rawIngestStage = await deriveWorkItemStage(
    prisma,
    'weekly_review_ingest',
    'weekly_analysis_run',
    run.id,
  )
  const ingestStage = applyUpstreamBlocking(rawIngestStage, weeklyReviewStageStatus)
  const stages: CycleStageInput[] = [
    {
      stageKey: 'weekly_review',
      status: weeklyReviewStageStatus,
      sourceType: 'weekly_analysis_run',
      sourceId: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? undefined,
    },
    {
      stageKey: 'weekly_review_ingest',
      sourceType: 'analysis_work_item',
      sourceId: run.id,
      ...ingestStage,
    },
  ]

  await upsertCycleWithStages(prisma, {
    kind: 'weekly_review',
    sourceType: 'weekly_analysis_run',
    sourceId: run.id,
    triggeredAt: run.startedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? undefined,
    stages,
    modelVersion: '1',
  })
}
