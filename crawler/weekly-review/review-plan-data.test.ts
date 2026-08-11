import { describe, expect, it } from 'vitest'
import {
  assemblePlanningData,
  loadWeeklyReviewPlanningData,
  type PlanningDataRows,
  type WeeklyReviewPlanningDataSource,
} from './review-plan-data'

describe('assemblePlanningData', () => {
  it('snapshot は observedAt の新しい順で latest/previous に割り当てる', () => {
    const rows: PlanningDataRows = {
      definitions: [{ id: 'l1', key: 'topic_alpha', currentRuleVersion: '2.0.0' }],
      aggregates: [{ labelDefinitionId: 'l1', trueCount: 20, totalCount: 100 }],
      snapshots: [
        {
          labelDefinitionId: 'l1',
          observedAt: new Date('2026-08-01T00:00:00Z'),
          prevalence: 0.1,
          coverage: 0.9,
          staleRatio: 0.01,
        },
        {
          labelDefinitionId: 'l1',
          observedAt: new Date('2026-08-08T00:00:00Z'),
          prevalence: 0.2,
          coverage: 0.8,
          staleRatio: 0.05,
        },
      ],
      activeFindingCounts: [{ labelDefinitionId: 'l1', count: 2 }],
      recentChangeCounts: [{ labelDefinitionId: 'l1', count: 4 }],
      candidates: [],
      changeCandidates: [],
    }

    const result = assemblePlanningData(rows)

    expect(result.labels[0]).toMatchObject({
      id: 'l1',
      key: 'topic_alpha',
      currentRuleVersion: '2.0.0',
      trueCount: 20,
      totalCount: 100,
      activeFindingCount: 2,
      recentChangeCount: 4,
      latestMetrics: { prevalence: 0.2, coverage: 0.8, staleRatio: 0.05 },
      previousMetrics: { prevalence: 0.1, coverage: 0.9, staleRatio: 0.01 },
    })
  })

  it('change candidate は同一 account/label の通常 candidate に changeType を付与する', () => {
    const common = {
      accountId: 'a1',
      labelDefinitionId: 'l1',
      labelKey: 'spam_alpha',
      value: false,
      confidence: 0.6,
      reason: 'near miss',
      ruleVersion: '1.0.0',
      labeledAt: new Date('2026-08-08T00:00:00Z'),
    }
    const rows: PlanningDataRows = {
      definitions: [{ id: 'l1', key: 'spam_alpha', currentRuleVersion: '1.0.0' }],
      aggregates: [],
      snapshots: [],
      activeFindingCounts: [],
      recentChangeCounts: [],
      candidates: [common],
      changeCandidates: [{ ...common, changeType: 'removed' }],
    }

    const result = assemblePlanningData(rows)

    expect(result.candidates).toEqual([{ ...common, changeType: 'removed' }])
  })

  it('aggregate が無い新規ラベルも zero count で計画対象に残す', () => {
    const rows: PlanningDataRows = {
      definitions: [{ id: 'new', key: 'topic_new', currentRuleVersion: null }],
      aggregates: [],
      snapshots: [],
      activeFindingCounts: [],
      recentChangeCounts: [],
      candidates: [],
      changeCandidates: [],
    }

    const result = assemblePlanningData(rows)

    expect(result.labels[0]).toMatchObject({
      id: 'new',
      currentRuleVersion: 'unknown',
      trueCount: 0,
      totalCount: 0,
    })
  })
  it('data source の各 read を同じ対象期間で集約する', async () => {
    const calls: string[] = []
    const emptyRows: PlanningDataRows = {
      definitions: [],
      aggregates: [],
      snapshots: [],
      activeFindingCounts: [],
      recentChangeCounts: [],
      candidates: [],
      changeCandidates: [],
    }
    const source: WeeklyReviewPlanningDataSource = {
      listDefinitions() {
        calls.push('definitions')
        return Promise.resolve(emptyRows.definitions)
      },
      listAggregates() {
        calls.push('aggregates')
        return Promise.resolve(emptyRows.aggregates)
      },
      listSnapshots(targetTo) {
        calls.push(`snapshots:${targetTo.toISOString()}`)
        return Promise.resolve(emptyRows.snapshots)
      },
      listActiveFindingCounts() {
        calls.push('findings')
        return Promise.resolve(emptyRows.activeFindingCounts)
      },
      listRecentChangeCounts(targetFrom, targetTo) {
        calls.push(`change-counts:${targetFrom.toISOString()}:${targetTo.toISOString()}`)
        return Promise.resolve(emptyRows.recentChangeCounts)
      },
      listRecentCandidates(targetFrom, targetTo, poolSize, seed) {
        calls.push(
          `candidates:${targetFrom.toISOString()}:${targetTo.toISOString()}:${poolSize}:${seed}`,
        )
        return Promise.resolve(emptyRows.candidates)
      },
      listChangeCandidates(targetFrom, targetTo, limit) {
        calls.push(`changes:${targetFrom.toISOString()}:${targetTo.toISOString()}:${limit}`)
        return Promise.resolve(emptyRows.changeCandidates)
      },
    }
    const targetFrom = new Date('2026-08-01T00:00:00Z')
    const targetTo = new Date('2026-08-08T00:00:00Z')

    await loadWeeklyReviewPlanningData(source, {
      targetFrom,
      targetTo,
      candidatePoolSize: 600,
      seed: 'run-seed',
    })

    expect(calls).toEqual([
      'definitions',
      'aggregates',
      'findings',
      `snapshots:${targetTo.toISOString()}`,
      `change-counts:${targetFrom.toISOString()}:${targetTo.toISOString()}`,
      `candidates:${targetFrom.toISOString()}:${targetTo.toISOString()}:600:run-seed`,
      `changes:${targetFrom.toISOString()}:${targetTo.toISOString()}:600`,
    ])
  })
})
