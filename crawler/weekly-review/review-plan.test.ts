import { describe, expect, it } from 'vitest'
import { buildWeeklyReviewPlan, type PlanningCandidate, type PlanningLabel } from './review-plan'

const targetFrom = new Date('2026-08-01T00:00:00Z')
const targetTo = new Date('2026-08-08T00:00:00Z')

function label(
  overrides: Partial<PlanningLabel> & Pick<PlanningLabel, 'id' | 'key'>,
): PlanningLabel {
  return {
    id: overrides.id,
    key: overrides.key,
    currentRuleVersion: overrides.currentRuleVersion ?? '1.0.0',
    trueCount: overrides.trueCount ?? 100,
    totalCount: overrides.totalCount ?? 1000,
    activeFindingCount: overrides.activeFindingCount ?? 0,
    recentChangeCount: overrides.recentChangeCount ?? 0,
    latestMetrics: overrides.latestMetrics,
    previousMetrics: overrides.previousMetrics,
  }
}

function candidate(
  labelDefinitionId: string,
  labelKey: string,
  accountId: string,
  value: boolean,
  overrides: Partial<PlanningCandidate> = {},
): PlanningCandidate {
  return {
    accountId,
    labelDefinitionId,
    labelKey,
    value,
    confidence: overrides.confidence ?? (value ? 0.8 : 0),
    reason: overrides.reason ?? (value ? 'positive evidence' : 'negative evidence'),
    ruleVersion: overrides.ruleVersion ?? '1.0.0',
    labeledAt: overrides.labeledAt ?? new Date('2026-08-07T00:00:00Z'),
    evaluable: overrides.evaluable ?? true,
    changeType: overrides.changeType,
  }
}

describe('buildWeeklyReviewPlan', () => {
  it('同じ seed と入力なら sample 順序まで同一になる', () => {
    const labels = [label({ id: 'l1', key: 'topic_alpha' })]
    const candidates = [
      candidate('l1', 'topic_alpha', 'a1', true),
      candidate('l1', 'topic_alpha', 'a2', true),
      candidate('l1', 'topic_alpha', 'a3', false),
      candidate('l1', 'topic_alpha', 'a4', false),
    ]

    const first = buildWeeklyReviewPlan({
      seed: 'run-123',
      budget: 4,
      targetFrom,
      targetTo,
      labels,
      candidates,
    })
    const second = buildWeeklyReviewPlan({
      seed: 'run-123',
      budget: 4,
      targetFrom,
      targetTo,
      labels,
      candidates,
    })

    expect(second).toEqual(first)
  })

  it('各ラベルから true と false の random audit を優先して確保する', () => {
    const labels = [label({ id: 'l1', key: 'topic_alpha' }), label({ id: 'l2', key: 'spam_beta' })]
    const candidates = [
      candidate('l1', 'topic_alpha', 'a1', true),
      candidate('l1', 'topic_alpha', 'a2', false),
      candidate('l2', 'spam_beta', 'b1', true),
      candidate('l2', 'spam_beta', 'b2', false),
    ]

    const plan = buildWeeklyReviewPlan({
      seed: 'run-baseline',
      budget: 4,
      targetFrom,
      targetTo,
      labels,
      candidates,
    })

    expect(plan.samples.map((sample) => [sample.labelKey, sample.sampleKind])).toEqual(
      expect.arrayContaining([
        ['topic_alpha', 'random_positive'],
        ['topic_alpha', 'random_negative'],
        ['spam_beta', 'random_positive'],
        ['spam_beta', 'random_negative'],
      ]),
    )
  })

  it('余剰 budget は recent change と境界例を優先し duplicate sample を作らない', () => {
    const labels = [label({ id: 'l1', key: 'bot_alpha', recentChangeCount: 8 })]
    const candidates = [
      candidate('l1', 'bot_alpha', 'a1', true, { confidence: 0.9 }),
      candidate('l1', 'bot_alpha', 'a2', false),
      candidate('l1', 'bot_alpha', 'a3', false, {
        confidence: 0.75,
        changeType: 'removed',
      }),
      candidate('l1', 'bot_alpha', 'a4', true, { confidence: 0.2 }),
      candidate('l1', 'bot_alpha', 'a5', true, { reason: 'rare reason' }),
    ]

    const plan = buildWeeklyReviewPlan({
      seed: 'run-targeted',
      budget: 5,
      targetFrom,
      targetTo,
      labels,
      candidates,
    })

    const targeted = plan.samples.filter((sample) => !sample.sampleKind.startsWith('random_'))
    expect(targeted.some((sample) => sample.sampleKind === 'recent_change')).toBe(true)
    expect(
      plan.samples.some((sample) =>
        sample.selectionSignals.some(
          (signal) =>
            signal === 'positive_evidence_negative' || signal === 'low_confidence_positive',
        ),
      ),
    ).toBe(true)
    expect(new Set(plan.samples.map((sample) => sample.sampleId)).size).toBe(plan.samples.length)
    expect(plan.samples).toHaveLength(5)
  })

  it('metric shift と active finding を持つラベルの targeted candidate を優先する', () => {
    const labels = [
      label({
        id: 'risky',
        key: 'spam_risky',
        activeFindingCount: 2,
        latestMetrics: { prevalence: 0.2, coverage: 0.7, staleRatio: 0.2 },
        previousMetrics: { prevalence: 0.1, coverage: 0.95, staleRatio: 0 },
      }),
      label({ id: 'stable', key: 'topic_stable' }),
    ]
    const candidates = [
      candidate('risky', 'spam_risky', 'r1', true),
      candidate('risky', 'spam_risky', 'r2', false),
      candidate('risky', 'spam_risky', 'r3', false, { confidence: 0.6 }),
      candidate('stable', 'topic_stable', 's1', true),
      candidate('stable', 'topic_stable', 's2', false),
      candidate('stable', 'topic_stable', 's3', false, { confidence: 0.6 }),
    ]

    const plan = buildWeeklyReviewPlan({
      seed: 'run-risk',
      budget: 5,
      targetFrom,
      targetTo,
      labels,
      candidates,
    })

    expect(plan.labels.find((item) => item.labelKey === 'spam_risky')?.riskScore).toBeGreaterThan(
      plan.labels.find((item) => item.labelKey === 'topic_stable')?.riskScore ?? 0,
    )
    expect(plan.samples[4]?.labelKey).toBe('spam_risky')
  })

  it('random baseline を全ラベルへ配分し risk が高いラベルだけに独占させない', () => {
    const labels = Array.from({ length: 10 }, (_, i) =>
      label({ id: `l${i}`, key: `label_${i}`, activeFindingCount: i === 0 ? 100 : 0 }),
    )
    const candidates = labels.flatMap((l) => [
      candidate(l.id, l.key, `${l.id}-pos`, true),
      candidate(l.id, l.key, `${l.id}-neg`, false),
    ])

    const plan = buildWeeklyReviewPlan({
      seed: 'run-baseline-spread',
      budget: 6,
      targetFrom,
      targetTo,
      labels,
      candidates,
    })

    const randomLabelIds = new Set(
      plan.samples
        .filter(
          (sample) =>
            sample.sampleKind === 'random_positive' || sample.sampleKind === 'random_negative',
        )
        .map((sample) => sample.labelDefinitionId),
    )
    expect(randomLabelIds.size).toBeGreaterThan(1)
  })

  it('evaluable=false の candidate を insufficient_support として他の targeted signal より優先する', () => {
    const l = label({ id: 'l1', key: 'label_one' })
    const insufficientCandidate = candidate('l1', 'label_one', 'account-insufficient', false, {
      confidence: 0.5,
      evaluable: false,
      ruleVersion: '0.9.0',
    })

    const plan = buildWeeklyReviewPlan({
      seed: 'run-insufficient',
      budget: 1,
      targetFrom,
      targetTo,
      labels: [l],
      candidates: [insufficientCandidate],
    })

    const sample = plan.samples.find((s) => s.accountId === 'account-insufficient')
    expect(sample?.sampleKind).toBe('insufficient_support')
  })

  it('high_confidence_negative を margin 付きの positive_evidence_negative に置き換える', () => {
    const l = label({ id: 'l1', key: 'label_one' })
    const belowMargin = candidate('l1', 'label_one', 'account-below-margin', false, {
      confidence: 0.95,
    })
    const aboveMargin = candidate('l1', 'label_one', 'account-above-margin', false, {
      confidence: 0.3,
    })

    const plan = buildWeeklyReviewPlan({
      seed: 'run-margin',
      budget: 2,
      targetFrom,
      targetTo,
      labels: [l],
      candidates: [belowMargin, aboveMargin],
    })

    const below = plan.samples.find((s) => s.accountId === 'account-below-margin')
    const above = plan.samples.find((s) => s.accountId === 'account-above-margin')
    expect(below?.selectionSignals).not.toContain('positive_evidence_negative')
    expect(above?.selectionSignals).toContain('positive_evidence_negative')
  })

  it('random sample には populationCounts から populationCount を設定する', () => {
    const l = label({ id: 'l1', key: 'label_one' })
    const c = candidate('l1', 'label_one', 'account-1', true)

    const plan = buildWeeklyReviewPlan({
      seed: 'run-population',
      budget: 1,
      targetFrom,
      targetTo,
      labels: [l],
      candidates: [c],
      populationCounts: new Map([['l1:true', 12_345]]),
    })

    const sample = plan.samples.find((s) => s.sampleKind === 'random_positive')
    expect(sample?.populationCount).toBe(12_345)
  })

  it('targeted sample には populationCount を設定しない', () => {
    const l = label({ id: 'l1', key: 'label_one' })
    const changeCandidate = candidate('l1', 'label_one', 'account-1', true, {
      changeType: 'value_changed',
    })

    const plan = buildWeeklyReviewPlan({
      seed: 'run-no-population',
      budget: 1,
      targetFrom,
      targetTo,
      labels: [l],
      candidates: [changeCandidate],
    })

    const sample = plan.samples.find((s) => s.sampleKind === 'recent_change')
    expect(sample?.populationCount).toBeUndefined()
  })
})
