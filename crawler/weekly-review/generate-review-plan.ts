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
  /**
   * plan 用 rows を単一 transaction (REPEATABLE READ) 内で読むためのコールバック実行器。
   * 本番実装は `prisma.$transaction` で包み、単体テストは即時実行版を渡せる。
   */
  runPlanningQuery: <T>(fn: (source: WeeklyReviewPlanningDataSource) => Promise<T>) => Promise<T>
}

export async function generateWeeklyReviewPlan(
  input: GenerateWeeklyReviewPlanInput,
  dependencies: GenerateWeeklyReviewPlanDependencies,
): Promise<WeeklyReviewPlan> {
  const run = await dependencies.store.getRun(input.runId)
  if (!run) throw new Error(`WeeklyAnalysisRun not found: ${input.runId}`)

  const { plan, targetFrom, targetTo } = await dependencies.runPlanningQuery(async (source) => {
    await source.assertSamplingReady()
    const snapshotAt = await source.readSnapshotAt()
    const window = buildReviewTargetWindow(snapshotAt)
    const planningData = await loadWeeklyReviewPlanningData(source, {
      ...window,
      candidatePoolSize: input.candidatePoolSize,
      seed: run.id,
    })
    const plan = buildWeeklyReviewPlan({
      seed: run.id,
      budget: input.budget,
      ...window,
      labels: planningData.labels,
      candidates: planningData.candidates,
      populationCounts: planningData.populationCounts,
    })
    return { plan, ...window }
  })

  await dependencies.store.recordPlanMetadata(run.id, {
    targetFrom,
    targetTo,
    analysisVersion: plan.strategyVersion,
    reviewPlan: plan,
  })
  return plan
}
