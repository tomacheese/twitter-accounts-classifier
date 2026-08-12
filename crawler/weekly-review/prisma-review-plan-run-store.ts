import type { Prisma, PrismaClient } from '../generated/prisma'
import type { WeeklyReviewRunPlanStore } from './generate-review-plan'

export class PrismaWeeklyReviewRunPlanStore implements WeeklyReviewRunPlanStore {
  public constructor(private readonly prisma: PrismaClient) {}

  public async getRun(id: string): Promise<{ id: string; startedAt: Date } | null> {
    return this.prisma.weeklyAnalysisRun.findUnique({
      where: { id },
      select: { id: true, startedAt: true },
    })
  }

  public async recordPlanMetadata(
    id: string,
    metadata: Parameters<WeeklyReviewRunPlanStore['recordPlanMetadata']>[1],
  ): Promise<void> {
    const { count } = await this.prisma.weeklyAnalysisRun.updateMany({
      where: { id, status: 'running' },
      data: {
        targetFrom: metadata.targetFrom,
        targetTo: metadata.targetTo,
        analysisVersion: metadata.analysisVersion,
        reviewPlan: metadata.reviewPlan as unknown as Prisma.InputJsonValue,
      },
    })
    if (count !== 1) throw new Error(`WeeklyAnalysisRun is not running: ${id}`)
  }
}
