import type { PlanningCandidate, PlanningLabel, PlanningMetrics } from './review-plan'

export interface PlanningDefinitionRow {
  id: string
  key: string
  currentRuleVersion: string | null
}

export interface PlanningAggregateRow {
  labelDefinitionId: string
  trueCount: number
  totalCount: number
}

export interface PlanningSnapshotRow extends PlanningMetrics {
  labelDefinitionId: string
  observedAt: Date
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
  aggregates: PlanningAggregateRow[]
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
  const aggregates = new Map(rows.aggregates.map((row) => [row.labelDefinitionId, row]))
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
    const aggregate = aggregates.get(definition.id)
    const orderedSnapshots = (snapshots.get(definition.id) ?? []).toSorted(
      (a, b) => b.observedAt.getTime() - a.observedAt.getTime(),
    )
    return {
      id: definition.id,
      key: definition.key,
      currentRuleVersion: definition.currentRuleVersion ?? 'unknown',
      trueCount: aggregate?.trueCount ?? 0,
      totalCount: aggregate?.totalCount ?? 0,
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
  listAggregates(): Promise<PlanningAggregateRow[]>
  listSnapshots(targetTo: Date): Promise<PlanningSnapshotRow[]>
  listActiveFindingCounts(): Promise<PlanningCountRow[]>
  listRecentChangeCounts(targetFrom: Date, targetTo: Date): Promise<PlanningCountRow[]>
  listRecentCandidates(
    targetFrom: Date,
    targetTo: Date,
    poolSize: number,
    seed: string,
  ): Promise<PlanningCandidateRow[]>
  listChangeCandidates(
    targetFrom: Date,
    targetTo: Date,
    limit: number,
  ): Promise<PlanningCandidateRow[]>
  /**
   * `targetFrom`〜`targetTo` の期間内に labeled された、当該ラベル×value のアカウント数
   * (relabel 履歴の行数ではない) を返す。`listRecentCandidates` と同じく
   * targetTo 時点の各 accountId × labelDefinitionId の最新1件を sampling unit とするため、
   * 無作為抽出プールの inclusion probability (`poolSize / populationCount`) を
   * 近似する母集団件数として使える (population frame が sample frame と一致する)。
   */
  listPopulationCounts(targetFrom: Date, targetTo: Date): Promise<PlanningPopulationCountRow[]>
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
    aggregates,
    activeFindingCounts,
    snapshots,
    recentChangeCounts,
    candidates,
    changeCandidates,
    populationCounts,
  ] = await Promise.all([
    source.listDefinitions(),
    source.listAggregates(),
    source.listActiveFindingCounts(),
    source.listSnapshots(options.targetTo),
    source.listRecentChangeCounts(options.targetFrom, options.targetTo),
    source.listRecentCandidates(
      options.targetFrom,
      options.targetTo,
      options.candidatePoolSize,
      options.seed,
    ),
    source.listChangeCandidates(options.targetFrom, options.targetTo, options.candidatePoolSize),
    source.listPopulationCounts(options.targetFrom, options.targetTo),
  ])

  return assemblePlanningData({
    definitions,
    aggregates,
    snapshots,
    activeFindingCounts,
    recentChangeCounts,
    candidates,
    changeCandidates,
    populationCounts,
  })
}
