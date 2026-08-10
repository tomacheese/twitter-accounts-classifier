import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { buildOrUpdateCrawlCycle } from './build-crawl-cycle'
import { buildOrUpdateBlockCycle } from './build-block-cycle'
import { buildOrUpdateWeeklyReviewCycle } from './build-weekly-review-cycle'

const logger = Logger.configure('analyzer:reconcile-active-cycles')

/**
 * この状態に達した OperationCycle は、対応する起点 Run 側の状態が変わらない限り
 * それ以上変化しないとみなし、reconcile の対象から外す。
 */
const TERMINAL_CYCLE_STATUSES = ['succeeded', 'partial', 'failed', 'cancelled']

/**
 * @param bySourceType - `sourceType` ごとに重複排除した `sourceId` を集約する Map
 * @param sourceType - 追加先の起点種別
 * @param sourceId - 追加する起点 ID
 */
function addSourceId(
  bySourceType: Map<string, Set<string>>,
  sourceType: string,
  sourceId: string,
): void {
  const existing = bySourceType.get(sourceType)
  if (existing) {
    existing.add(sourceId)
    return
  }
  bySourceType.set(sourceType, new Set([sourceId]))
}

/**
 * active な起点 Run と、未確定 (non-terminal) な OperationCycle が指す起点 Run を
 * まとめて既存ビルダーへ流し、Cycle/Stage を最新化する。
 *
 * 「active な起点 Run」だけを対象にすると、起点 Run が terminal に遷移した直後から
 * downstream AnalysisWorkItem が settle するまでの間、Cycle が古い running 表示のまま
 * 残ってしまう (Cycle の再計算は handleWorkItemSettled() の WorkItem settle 時にしか
 * 走らないため)。この穴を、未確定 OperationCycle も reconcile 対象に含めることで塞ぐ。
 * @param prisma - Prisma クライアント
 */
export async function reconcileActiveOperationCycles(prisma: PrismaClient): Promise<void> {
  const bySourceType = new Map<string, Set<string>>()

  const [runningCrawlRuns, runningBlockRuns, runningWeeklyAnalysisRuns, nonTerminalCycles] =
    await Promise.all([
      prisma.crawlRun.findMany({ where: { status: 'running' }, select: { id: true } }),
      prisma.blockRun.findMany({ where: { status: 'running' }, select: { id: true } }),
      prisma.weeklyAnalysisRun.findMany({ where: { status: 'running' }, select: { id: true } }),
      prisma.operationCycle.findMany({
        where: { status: { notIn: TERMINAL_CYCLE_STATUSES } },
        select: { sourceType: true, sourceId: true },
      }),
    ])

  for (const run of runningCrawlRuns) addSourceId(bySourceType, 'crawl_run', run.id)
  for (const run of runningBlockRuns) addSourceId(bySourceType, 'block_run', run.id)
  for (const run of runningWeeklyAnalysisRuns) {
    addSourceId(bySourceType, 'weekly_analysis_run', run.id)
  }
  for (const cycle of nonTerminalCycles) addSourceId(bySourceType, cycle.sourceType, cycle.sourceId)

  for (const [sourceType, sourceIds] of bySourceType) {
    for (const sourceId of sourceIds) {
      switch (sourceType) {
        case 'crawl_run': {
          await buildOrUpdateCrawlCycle(prisma, { crawlRunId: sourceId })
          break
        }
        case 'block_run': {
          await buildOrUpdateBlockCycle(prisma, { blockRunId: sourceId })
          break
        }
        case 'weekly_analysis_run': {
          await buildOrUpdateWeeklyReviewCycle(prisma, { weeklyAnalysisRunId: sourceId })
          break
        }
        default: {
          logger.warn(`no operation cycle builder for source type: ${sourceType}`)
        }
      }
    }
  }
}
