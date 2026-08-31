import type { PlanningCandidate, PlanningLabel, PlanningMetrics } from './review-plan'

export interface PlanningDefinitionRow {
  id: string
  key: string
  currentRuleVersion: string | null
}

export interface PlanningSnapshotRow extends PlanningMetrics {
  labelDefinitionId: string
  observedAt: Date
  trueCount: number
  evaluatedCount: number
}

export interface PlanningCountRow {
  labelDefinitionId: string
  count: number
}

export interface PlanningCandidateRow extends Omit<PlanningCandidate, 'changeType'> {
  changeType?: string
}

export interface PlanningPopulationCountRow {
  labelDefinitionId: string
  value: boolean
  count: number
}

export interface PlanningDataRows {
  definitions: PlanningDefinitionRow[]
  snapshots: PlanningSnapshotRow[]
  activeFindingCounts: PlanningCountRow[]
  recentChangeCounts: PlanningCountRow[]
  candidates: PlanningCandidateRow[]
  changeCandidates: PlanningCandidateRow[]
  populationCounts: PlanningPopulationCountRow[]
}

export interface PlanningData {
  labels: PlanningLabel[]
  candidates: PlanningCandidate[]
  populationCounts: Map<string, number>
}

function metrics(row: PlanningSnapshotRow | undefined): PlanningMetrics | undefined {
  if (!row) return undefined
  return {
    prevalence: row.prevalence,
    coverage: row.coverage,
    staleRatio: row.staleRatio,
  }
}

export function assemblePlanningData(rows: PlanningDataRows): PlanningData {
  const activeFindingCounts = new Map(
    rows.activeFindingCounts.map((row) => [row.labelDefinitionId, row.count]),
  )
  const recentChangeCounts = new Map(
    rows.recentChangeCounts.map((row) => [row.labelDefinitionId, row.count]),
  )
  const snapshots = new Map<string, PlanningSnapshotRow[]>()
  for (const row of rows.snapshots) {
    const existing = snapshots.get(row.labelDefinitionId) ?? []
    existing.push(row)
    snapshots.set(row.labelDefinitionId, existing)
  }

  const labels = rows.definitions.map((definition) => {
    const orderedSnapshots = (snapshots.get(definition.id) ?? []).toSorted(
      (a, b) => b.observedAt.getTime() - a.observedAt.getTime(),
    )
    return {
      id: definition.id,
      key: definition.key,
      currentRuleVersion: definition.currentRuleVersion ?? 'unknown',
      trueCount: orderedSnapshots[0]?.trueCount ?? 0,
      totalCount: orderedSnapshots[0]?.evaluatedCount ?? 0,
      activeFindingCount: activeFindingCounts.get(definition.id) ?? 0,
      recentChangeCount: recentChangeCounts.get(definition.id) ?? 0,
      latestMetrics: metrics(orderedSnapshots[0]),
      previousMetrics: metrics(orderedSnapshots[1]),
    }
  })

  const candidates = new Map<string, PlanningCandidate>()
  for (const row of rows.candidates) {
    candidates.set(`${row.labelDefinitionId}:${row.accountId}`, row)
  }
  for (const row of rows.changeCandidates) {
    const key = `${row.labelDefinitionId}:${row.accountId}`
    const existing = candidates.get(key)
    candidates.set(key, existing ? { ...existing, changeType: row.changeType } : row)
  }

  const populationCounts = new Map(
    rows.populationCounts.map((row) => [`${row.labelDefinitionId}:${row.value}`, row.count]),
  )

  return { labels, candidates: [...candidates.values()], populationCounts }
}

export interface WeeklyReviewPlanningDataSource {
  listDefinitions(): Promise<PlanningDefinitionRow[]>
  listSnapshots(targetTo: Date): Promise<PlanningSnapshotRow[]>
  listActiveFindingCounts(): Promise<PlanningCountRow[]>
  listRecentChangeCounts(targetFrom: Date, targetTo: Date): Promise<PlanningCountRow[]>
  listBaselineCandidates(poolSize: number, seed: string): Promise<PlanningCandidateRow[]>
  listChangeCandidates(
    targetFrom: Date,
    targetTo: Date,
    limit: number,
  ): Promise<PlanningCandidateRow[]>
  /**
   * `WeeklyReviewSampleBucketCount` を集計した、ラベル×value ごとの current/evaluable
   * 母集団件数を返す。近似値であり、`M=4096`(全 bucket 読み込み)の縮退分岐でのみ
   * `poolSize / populationCount` が厳密な inclusion probability と一致する。
   */
  listPopulationCounts(): Promise<PlanningPopulationCountRow[]>
  /**
   * sampling frame として使う read model (`AccountClassificationLatest` /
   * `WeeklyReviewSampleBucketCount`) が準備完了しているか検証する。
   * 未完了なら reject し、呼び出し元は plan 生成を中断する。
   */
  assertSamplingReady(): Promise<void>
  /** REPEATABLE READ transaction 冒頭の DB 時刻を snapshotAt として返す。 */
  readSnapshotAt(): Promise<Date>
}

export interface LoadWeeklyReviewPlanningDataOptions {
  targetFrom: Date
  targetTo: Date
  candidatePoolSize: number
  seed: string
}

export async function loadWeeklyReviewPlanningData(
  source: WeeklyReviewPlanningDataSource,
  options: LoadWeeklyReviewPlanningDataOptions,
): Promise<PlanningData> {
  const [
    definitions,
    activeFindingCounts,
    snapshots,
    recentChangeCounts,
    candidates,
    changeCandidates,
    populationCounts,
  ] = await Promise.all([
    source.listDefinitions(),
    source.listActiveFindingCounts(),
    source.listSnapshots(options.targetTo),
    source.listRecentChangeCounts(options.targetFrom, options.targetTo),
    source.listBaselineCandidates(options.candidatePoolSize, options.seed),
    source.listChangeCandidates(options.targetFrom, options.targetTo, options.candidatePoolSize),
    source.listPopulationCounts(),
  ])

  return assemblePlanningData({
    definitions,
    snapshots,
    activeFindingCounts,
    recentChangeCounts,
    candidates,
    changeCandidates,
    populationCounts,
  })
}
