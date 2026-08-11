import { describe, expect, it } from 'vitest'
import { generateWeeklyReviewPlan, type WeeklyReviewRunPlanStore } from './generate-review-plan'
import type { WeeklyReviewPlanningDataSource } from './review-plan-data'

const startedAt = new Date('2026-08-12T00:00:00Z')

function emptySource(): WeeklyReviewPlanningDataSource {
  return {
    listDefinitions() {
      return Promise.resolve([])
    },
    listAggregates() {
      return Promise.resolve([])
    },
    listSnapshots() {
      return Promise.resolve([])
    },
    listActiveFindingCounts() {
      return Promise.resolve([])
    },
    listRecentChangeCounts() {
      return Promise.resolve([])
    },
    listRecentCandidates() {
      return Promise.resolve([])
    },
    listChangeCandidates() {
      return Promise.resolve([])
    },
  }
}

describe('generateWeeklyReviewPlan', () => {
  it('run ID を seed に使い対象期間と strategy を run metadata に記録する', async () => {
    const recorded: unknown[] = []
    const store: WeeklyReviewRunPlanStore = {
      getRun(id) {
        return Promise.resolve(id === 'run-1' ? { id, startedAt } : null)
      },
      recordPlanMetadata(id, metadata) {
        recorded.push({ id, metadata })
        return Promise.resolve()
      },
    }

    const plan = await generateWeeklyReviewPlan(
      { runId: 'run-1', budget: 240, candidatePoolSize: 600 },
      { store, source: emptySource() },
    )

    expect(plan).toMatchObject({
      seed: 'run-1',
      budget: 240,
      strategyVersion: 'risk-stratified/1',
      targetFrom: '2026-08-05T00:00:00.000Z',
      targetTo: '2026-08-12T00:00:00.000Z',
    })
    expect(recorded).toEqual([
      {
        id: 'run-1',
        metadata: {
          targetFrom: new Date('2026-08-05T00:00:00Z'),
          targetTo: startedAt,
          analysisVersion: 'risk-stratified/1',
          reviewPlan: expect.objectContaining({
            seed: 'run-1',
            strategyVersion: 'risk-stratified/1',
            budget: 240,
          }),
        },
      },
    ])
  })

  it('存在しない run ID は拒否する', async () => {
    const store: WeeklyReviewRunPlanStore = {
      getRun() {
        return Promise.resolve(null)
      },
      recordPlanMetadata() {
        return Promise.resolve()
      },
    }

    await expect(
      generateWeeklyReviewPlan(
        { runId: 'missing', budget: 240, candidatePoolSize: 600 },
        { store, source: emptySource() },
      ),
    ).rejects.toThrow('WeeklyAnalysisRun not found: missing')
  })
})
