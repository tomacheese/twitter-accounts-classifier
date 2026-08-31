import { describe, expect, it } from 'vitest'
import { generateWeeklyReviewPlan, type WeeklyReviewRunPlanStore } from './generate-review-plan'
import type { WeeklyReviewPlanningDataSource } from './review-plan-data'

const startedAt = new Date('2026-08-12T00:00:00Z')
const snapshotAt = new Date('2026-08-15T00:00:00Z')

function emptySource(
  overrides: Partial<WeeklyReviewPlanningDataSource> = {},
): WeeklyReviewPlanningDataSource {
  return {
    listDefinitions() {
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
    listBaselineCandidates() {
      return Promise.resolve([])
    },
    listChangeCandidates() {
      return Promise.resolve([])
    },
    listPopulationCounts() {
      return Promise.resolve([])
    },
    assertSamplingReady() {
      return Promise.resolve()
    },
    readSnapshotAt() {
      return Promise.resolve(snapshotAt)
    },
    ...overrides,
  }
}

describe('generateWeeklyReviewPlan', () => {
  it('run ID を seed に使い、readSnapshotAt の返り値から対象期間を算出する', async () => {
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
      { store, runPlanningQuery: (fn) => fn(emptySource()) },
    )

    expect(plan).toMatchObject({
      seed: 'run-1',
      budget: 240,
      strategyVersion: 'risk-stratified/3',
      targetFrom: '2026-08-08T00:00:00.000Z',
      targetTo: '2026-08-15T00:00:00.000Z',
    })
    expect(recorded).toEqual([
      {
        id: 'run-1',
        metadata: {
          targetFrom: new Date('2026-08-08T00:00:00Z'),
          targetTo: snapshotAt,
          analysisVersion: 'risk-stratified/3',
          reviewPlan: expect.objectContaining({
            seed: 'run-1',
            strategyVersion: 'risk-stratified/3',
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
        { store, runPlanningQuery: (fn) => fn(emptySource()) },
      ),
    ).rejects.toThrow('WeeklyAnalysisRun not found: missing')
  })

  it('assertSamplingReady は他の query より先に呼ばれる', async () => {
    const calls: string[] = []
    const store: WeeklyReviewRunPlanStore = {
      getRun(id) {
        return Promise.resolve({ id, startedAt })
      },
      recordPlanMetadata() {
        return Promise.resolve()
      },
    }
    const source = emptySource({
      assertSamplingReady() {
        calls.push('assert-sampling-ready')
        return Promise.resolve()
      },
      listDefinitions() {
        calls.push('definitions')
        return Promise.resolve([])
      },
      readSnapshotAt() {
        calls.push('read-snapshot-at')
        return Promise.resolve(snapshotAt)
      },
    })

    await generateWeeklyReviewPlan(
      { runId: 'run-1', budget: 240, candidatePoolSize: 600 },
      { store, runPlanningQuery: (fn) => fn(source) },
    )

    expect(calls[0]).toBe('assert-sampling-ready')
    expect(calls.indexOf('assert-sampling-ready')).toBeLessThan(calls.indexOf('definitions'))
  })

  it('assertSamplingReady が reject したら plan を生成せず recordPlanMetadata も呼ばない', async () => {
    let recordCalled = false
    const store: WeeklyReviewRunPlanStore = {
      getRun(id) {
        return Promise.resolve({ id, startedAt })
      },
      recordPlanMetadata() {
        recordCalled = true
        return Promise.resolve()
      },
    }
    const source = emptySource({
      assertSamplingReady() {
        return Promise.reject(new Error('sampling frame is not ready'))
      },
    })

    await expect(
      generateWeeklyReviewPlan(
        { runId: 'run-1', budget: 240, candidatePoolSize: 600 },
        { store, runPlanningQuery: (fn) => fn(source) },
      ),
    ).rejects.toThrow('sampling frame is not ready')
    expect(recordCalled).toBe(false)
  })
})
