import { createHash } from 'node:crypto'

export interface PlanningMetrics {
  prevalence: number
  coverage: number
  staleRatio: number
}

export interface PlanningLabel {
  id: string
  key: string
  currentRuleVersion: string
  trueCount: number
  totalCount: number
  activeFindingCount: number
  recentChangeCount: number
  latestMetrics?: PlanningMetrics
  previousMetrics?: PlanningMetrics
}

export interface PlanningCandidate {
  accountId: string
  labelDefinitionId: string
  labelKey: string
  value: boolean
  confidence: number
  reason: string
  ruleVersion: string
  labeledAt: Date
  evaluable: boolean
  recentTweetsFetchStatus?: string | null
  lastRecentTweetsAttemptedAt?: Date | null
  lastRecentTweetsFetchedAt?: Date | null
  changeType?: string
}

export type WeeklyReviewSampleKind =
  | 'random_positive'
  | 'random_negative'
  | 'recent_change'
  | 'high_confidence_negative'
  | 'positive_evidence_negative'
  | 'low_confidence_positive'
  | 'old_rule_version'
  | 'rare_reason'
  | 'risk_targeted'
  | 'insufficient_support'

export type WeeklyReviewSelectionSignal = Exclude<
  WeeklyReviewSampleKind,
  'random_positive' | 'random_negative' | 'risk_targeted'
>

export interface WeeklyReviewSample {
  sampleId: string
  accountId: string
  labelDefinitionId: string
  labelKey: string
  classifierValue: boolean
  classifierConfidence: number
  classifierReason: string
  ruleVersion: string
  labeledAt: string
  recentTweetsFetchStatus?: string | null
  lastRecentTweetsAttemptedAt?: string | null
  lastRecentTweetsFetchedAt?: string | null
  sampleKind: WeeklyReviewSampleKind
  priorityScore: number
  selectionSignals: WeeklyReviewSelectionSignal[]
  /**
   * random_positive/random_negative サンプルにのみ設定する (targeted サンプルは持たない)。
   * `WeeklyReviewSampleBucketCount` から得るこの値自体は正確である。
   * ただし `poolSize / populationCount` を候補の inclusion probability とみなす場合は近似である。
   * 厳密に一致するのは `M=4096`(全 bucket 読み込み)の縮退分岐のみである。
   */
  populationCount?: number
}

export interface WeeklyReviewPlanLabel {
  labelDefinitionId: string
  labelKey: string
  riskScore: number
  baselineSampleCount: number
  targetedSampleCount: number
}

export interface WeeklyReviewPlan {
  schemaVersion: 1
  strategyVersion: 'risk-stratified/3'
  seed: string
  budget: number
  targetFrom: string
  targetTo: string
  labels: WeeklyReviewPlanLabel[]
  samples: WeeklyReviewSample[]
}

/** キーは `${labelDefinitionId}:${value}`。 */
export type PopulationCountsByLabelAndValue = Map<string, number>

export interface BuildWeeklyReviewPlanInput {
  seed: string
  budget: number
  targetFrom: Date
  targetTo: Date
  labels: PlanningLabel[]
  candidates: PlanningCandidate[]
  populationCounts?: PopulationCountsByLabelAndValue
}

// value=false の candidate は証拠がないほど confidence が 1 に近づくため、
// 単純な confidence>0 では大半の value=false candidate を毎回フラグしてしまう。
// margin 未満、つまり陽性方向へ幾らか傾いた証拠が残るものだけを審査対象にする。
const NEGATIVE_EVIDENCE_MARGIN = 0.9

function stableRank(seed: string, value: string): string {
  return createHash('sha256').update(`${seed}\0${value}`).digest('hex')
}

function relativeDelta(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 1
  return Math.abs(current - previous) / Math.abs(previous)
}

function computeRiskScore(label: PlanningLabel): number {
  let score = 1
  score += Math.min(4, label.activeFindingCount * 2)
  if (label.recentChangeCount > 0) score += Math.min(3, Math.log2(label.recentChangeCount + 1))

  if (label.latestMetrics && label.previousMetrics) {
    const shift = relativeDelta(label.latestMetrics.prevalence, label.previousMetrics.prevalence)
    if (shift >= 0.3) score += 3
    else if (shift >= 0.1) score += 1
  }
  if (label.latestMetrics && label.latestMetrics.coverage < 0.8) score += 2
  if (label.latestMetrics && label.latestMetrics.staleRatio > 0.1) score += 2
  return Number(score.toFixed(3))
}

function toSample(
  candidate: PlanningCandidate,
  sampleKind: WeeklyReviewSampleKind,
  priorityScore: number,
  selectionSignals: WeeklyReviewSelectionSignal[],
  populationCount?: number,
): WeeklyReviewSample {
  return {
    sampleId: `${candidate.labelDefinitionId}:${candidate.accountId}`,
    accountId: candidate.accountId,
    labelDefinitionId: candidate.labelDefinitionId,
    labelKey: candidate.labelKey,
    classifierValue: candidate.value,
    classifierConfidence: candidate.confidence,
    classifierReason: candidate.reason,
    ruleVersion: candidate.ruleVersion,
    labeledAt: candidate.labeledAt.toISOString(),
    ...(candidate.recentTweetsFetchStatus === undefined
      ? {}
      : { recentTweetsFetchStatus: candidate.recentTweetsFetchStatus }),
    ...(candidate.lastRecentTweetsAttemptedAt === undefined
      ? {}
      : {
          lastRecentTweetsAttemptedAt: candidate.lastRecentTweetsAttemptedAt?.toISOString() ?? null,
        }),
    ...(candidate.lastRecentTweetsFetchedAt === undefined
      ? {}
      : { lastRecentTweetsFetchedAt: candidate.lastRecentTweetsFetchedAt?.toISOString() ?? null }),
    sampleKind,
    priorityScore,
    selectionSignals,
    ...(populationCount === undefined ? {} : { populationCount }),
  }
}

function selectionSignals(
  candidate: PlanningCandidate,
  label: PlanningLabel,
  reasonFrequency: number,
): WeeklyReviewSelectionSignal[] {
  const signals: WeeklyReviewSelectionSignal[] = []
  if (!candidate.evaluable) signals.push('insufficient_support')
  if (candidate.changeType) signals.push('recent_change')
  if (candidate.ruleVersion !== label.currentRuleVersion) signals.push('old_rule_version')
  if (!candidate.value && candidate.confidence < NEGATIVE_EVIDENCE_MARGIN) {
    signals.push('positive_evidence_negative')
  }
  if (candidate.value && candidate.confidence < 0.5) signals.push('low_confidence_positive')
  if (reasonFrequency <= 2) signals.push('rare_reason')
  return signals
}

function targetedKind(
  candidate: PlanningCandidate,
  label: PlanningLabel,
  reasonFrequency: number,
): { kind: WeeklyReviewSampleKind; score: number } {
  const risk = computeRiskScore(label)
  if (!candidate.evaluable) return { kind: 'insufficient_support', score: risk + 9 }
  if (candidate.changeType) return { kind: 'recent_change', score: risk + 8 }
  if (candidate.ruleVersion !== label.currentRuleVersion) {
    return { kind: 'old_rule_version', score: risk + 6 }
  }
  if (!candidate.value && candidate.confidence < NEGATIVE_EVIDENCE_MARGIN) {
    return {
      kind: 'positive_evidence_negative',
      score: risk + 5 + (NEGATIVE_EVIDENCE_MARGIN - candidate.confidence) * 3,
    }
  }
  if (candidate.value && candidate.confidence < 0.5) {
    return { kind: 'low_confidence_positive', score: risk + 5 + (0.5 - candidate.confidence) * 3 }
  }
  if (reasonFrequency <= 2) return { kind: 'rare_reason', score: risk + 2 }
  return { kind: 'risk_targeted', score: risk }
}

export function buildWeeklyReviewPlan(input: BuildWeeklyReviewPlanInput): WeeklyReviewPlan {
  const labelsById = new Map(input.labels.map((label) => [label.id, label]))
  const candidatesByLabel = new Map<string, PlanningCandidate[]>()
  for (const candidate of input.candidates) {
    const existing = candidatesByLabel.get(candidate.labelDefinitionId) ?? []
    existing.push(candidate)
    candidatesByLabel.set(candidate.labelDefinitionId, existing)
  }

  const riskByLabel = new Map(input.labels.map((label) => [label.id, computeRiskScore(label)]))
  const selected = new Map<string, WeeklyReviewSample>()

  // targeted fill 用の risk 順とは別に、random baseline はラベルを risk と無関係な
  // seed 依存の順序で回すことで、budget が小さくても risk 最上位のラベルだけに独占されない。
  const shuffledLabels = input.labels.toSorted((a, b) =>
    stableRank(input.seed, `${a.id}:baseline-order`).localeCompare(
      stableRank(input.seed, `${b.id}:baseline-order`),
    ),
  )
  const populationCounts = input.populationCounts ?? new Map<string, number>()

  for (const label of shuffledLabels) {
    if (selected.size >= input.budget) break
    const pool = candidatesByLabel.get(label.id) ?? []
    const reasonCounts = new Map<string, number>()
    for (const item of pool) reasonCounts.set(item.reason, (reasonCounts.get(item.reason) ?? 0) + 1)
    for (const value of [true, false]) {
      if (selected.size >= input.budget) break
      // evaluable=false の candidate は support 不足で不偏 audit の代表例として使えないため、
      // random baseline の対象からは外し targeted fill 側の insufficient_support に委ねる。
      // recent_change candidate は listRecentCandidates のハッシュ層化抽出を経ておらず
      // populationCount が前提とする inclusion probability と噛み合わないため、
      // random baseline の対象からは外し targeted fill 側の recent_change に委ねる。
      const candidate = pool
        .filter((item) => item.value === value && item.evaluable && !item.changeType)
        .toSorted((a, b) =>
          stableRank(input.seed, `${a.labelDefinitionId}:${a.accountId}:baseline`).localeCompare(
            stableRank(input.seed, `${b.labelDefinitionId}:${b.accountId}:baseline`),
          ),
        )
        .at(0)
      if (!candidate) continue
      const kind = value ? 'random_positive' : 'random_negative'
      selected.set(
        `${candidate.labelDefinitionId}:${candidate.accountId}`,
        toSample(
          candidate,
          kind,
          0,
          selectionSignals(candidate, label, reasonCounts.get(candidate.reason) ?? 0),
          populationCounts.get(`${label.id}:${value}`),
        ),
      )
    }
  }

  const targetedCandidates: { sample: WeeklyReviewSample; rank: string }[] = []
  for (const [labelDefinitionId, pool] of candidatesByLabel) {
    const label = labelsById.get(labelDefinitionId)
    if (!label) continue
    const reasonCounts = new Map<string, number>()
    for (const candidate of pool) {
      reasonCounts.set(candidate.reason, (reasonCounts.get(candidate.reason) ?? 0) + 1)
    }
    for (const candidate of pool) {
      const sampleId = `${candidate.labelDefinitionId}:${candidate.accountId}`
      if (selected.has(sampleId)) continue
      const targeted = targetedKind(candidate, label, reasonCounts.get(candidate.reason) ?? 0)
      targetedCandidates.push({
        sample: toSample(
          candidate,
          targeted.kind,
          Number(targeted.score.toFixed(3)),
          selectionSignals(candidate, label, reasonCounts.get(candidate.reason) ?? 0),
        ),
        rank: stableRank(input.seed, `${sampleId}:${targeted.kind}`),
      })
    }
  }

  const sortedTargetedCandidates = targetedCandidates.toSorted((a, b) => {
    if (b.sample.priorityScore !== a.sample.priorityScore) {
      return b.sample.priorityScore - a.sample.priorityScore
    }
    return a.rank.localeCompare(b.rank)
  })
  for (const candidate of sortedTargetedCandidates) {
    if (selected.size >= input.budget) break
    selected.set(candidate.sample.sampleId, candidate.sample)
  }

  const samples = [...selected.values()]
  const labelSummaries = input.labels.map((label) => {
    const own = samples.filter((sample) => sample.labelDefinitionId === label.id)
    return {
      labelDefinitionId: label.id,
      labelKey: label.key,
      riskScore: riskByLabel.get(label.id) ?? 0,
      baselineSampleCount: own.filter((sample) => sample.sampleKind.startsWith('random_')).length,
      targetedSampleCount: own.filter((sample) => !sample.sampleKind.startsWith('random_')).length,
    }
  })

  return {
    schemaVersion: 1,
    strategyVersion: 'risk-stratified/3',
    seed: input.seed,
    budget: input.budget,
    targetFrom: input.targetFrom.toISOString(),
    targetTo: input.targetTo.toISOString(),
    labels: labelSummaries,
    samples,
  }
}
