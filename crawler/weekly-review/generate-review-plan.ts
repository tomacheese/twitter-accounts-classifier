import { buildWeeklyReviewPlan, type WeeklyReviewPlan } from './review-plan'
import {
  loadWeeklyReviewPlanningData,
  type WeeklyReviewPlanningDataSource,
} from './review-plan-data'
import { buildReviewTargetWindow } from './review-plan-run'

export interface WeeklyReviewRunPlanStore {
  getRun(id: string): Promise<{ id: string; startedAt: Date } | null>
  recordPlanMetadata(
    id: string,
    metadata: {
      targetFrom: Date
      targetTo: Date
      analysisVersion: string
      reviewPlan: WeeklyReviewPlan
    },
  ): Promise<void>
}

export interface GenerateWeeklyReviewPlanInput {
  runId: string
  budget: number
  candidatePoolSize: number
}

export interface GenerateWeeklyReviewPlanDependencies {
  store: WeeklyReviewRunPlanStore
  source: WeeklyReviewPlanningDataSource
}

export async function generateWeeklyReviewPlan(
  input: GenerateWeeklyReviewPlanInput,
  dependencies: GenerateWeeklyReviewPlanDependencies,
): Promise<WeeklyReviewPlan> {
  const run = await dependencies.store.getRun(input.runId)
  if (!run) throw new Error(`WeeklyAnalysisRun not found: ${input.runId}`)

  const { targetFrom, targetTo } = buildReviewTargetWindow(run.startedAt)
  const planningData = await loadWeeklyReviewPlanningData(dependencies.source, {
    targetFrom,
    targetTo,
    candidatePoolSize: input.candidatePoolSize,
    seed: run.id,
  })
  const plan = buildWeeklyReviewPlan({
    seed: run.id,
    budget: input.budget,
    targetFrom,
    targetTo,
    labels: planningData.labels,
    candidates: planningData.candidates,
    populationCounts: planningData.populationCounts,
  })

  await dependencies.store.recordPlanMetadata(run.id, {
    targetFrom,
    targetTo,
    analysisVersion: plan.strategyVersion,
    reviewPlan: plan,
  })
  return plan
}
