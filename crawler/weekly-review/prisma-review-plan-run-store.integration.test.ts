import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '../generated/prisma'
import { PrismaWeeklyReviewRunPlanStore } from './prisma-review-plan-run-store'

const prisma = new PrismaClient()

afterAll(async () => {
  await prisma.$disconnect()
})

describe.skipIf(!process.env.DATABASE_URL)('PrismaWeeklyReviewRunPlanStore', () => {
  it('running run に target window・analysisVersion・reviewPlan を保存する', async () => {
    const id = `review_plan_${randomUUID()}`
    const startedAt = new Date('2026-08-12T00:00:00Z')
    await prisma.weeklyAnalysisRun.create({
      data: {
        id,
        startedAt,
        lastHeartbeatAt: startedAt,
        status: 'running',
        sampledAccountIds: [],
      },
    })

    try {
      const store = new PrismaWeeklyReviewRunPlanStore(prisma)
      const run = await store.getRun(id)
      expect(run).toEqual({ id, startedAt })

      const reviewPlan = { schemaVersion: 1, strategyVersion: 'risk-stratified/2', samples: [] }
      await store.recordPlanMetadata(id, {
        targetFrom: new Date('2026-08-05T00:00:00Z'),
        targetTo: startedAt,
        analysisVersion: 'risk-stratified/2',
        reviewPlan: reviewPlan as never,
      })

      const updated = await prisma.weeklyAnalysisRun.findUniqueOrThrow({ where: { id } })
      expect(updated).toMatchObject({
        targetFrom: new Date('2026-08-05T00:00:00Z'),
        targetTo: startedAt,
        analysisVersion: 'risk-stratified/2',
        reviewPlan,
      })
    } finally {
      await prisma.weeklyAnalysisRun.deleteMany({ where: { id } })
    }
  })

  it('terminal run への plan 書き込みは拒否する', async () => {
    const id = `review_plan_terminal_${randomUUID()}`
    const startedAt = new Date('2026-08-12T00:00:00Z')
    await prisma.weeklyAnalysisRun.create({
      data: {
        id,
        startedAt,
        lastHeartbeatAt: startedAt,
        finishedAt: startedAt,
        status: 'success',
        sampledAccountIds: [],
      },
    })

    try {
      const store = new PrismaWeeklyReviewRunPlanStore(prisma)
      await expect(
        store.recordPlanMetadata(id, {
          targetFrom: new Date('2026-08-05T00:00:00Z'),
          targetTo: startedAt,
          analysisVersion: 'risk-stratified/2',
          reviewPlan: {
            schemaVersion: 1,
            strategyVersion: 'risk-stratified/2',
            seed: id,
            budget: 1,
            targetFrom: '2026-08-05T00:00:00.000Z',
            targetTo: startedAt.toISOString(),
            labels: [],
            samples: [],
          },
        }),
      ).rejects.toThrow(`WeeklyAnalysisRun is not running: ${id}`)
    } finally {
      await prisma.weeklyAnalysisRun.deleteMany({ where: { id } })
    }
  })
})
