import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { buildOrUpdateCrawlCycle } from './build-crawl-cycle'
import { buildOrUpdateBlockCycle } from './build-block-cycle'
import { buildOrUpdateWeeklyReviewCycle } from './build-weekly-review-cycle'
import type { CycleStatus } from './cycle-common'

const logger = Logger.configure('analyzer:reconcile-active-cycles')

/**
 * この一覧の状態に達した OperationCycle は、起点 Run が変化しない限り reconcile 対象から外す。
 */
const TERMINAL_CYCLE_STATUSES: CycleStatus[] = ['succeeded', 'partial', 'failed', 'cancelled']

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
 * active な起点 Run と、未確定 (non-terminal) な OperationCycle が指す起点 Run を、
 * まとめて既存ビルダーへ流し Cycle/Stage を最新化する。
 *
 * active な起点 Run だけでは Cycle 更新に穴が残る。
 * terminal 遷移直後から downstream WorkItem の settle までの間、古い running 表示のままになるためである。
 * この穴は、未確定 OperationCycle も対象に含めることで塞ぐ。
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
      try {
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
      } catch (error) {
        // 1 件の再計算失敗で他の Cycle まで reconcile できなくなるのを避けるため、
        // ここで隔離して次の pass に委ねる。
        logger.warn(`failed to reconcile cycle: ${sourceType}/${sourceId}`, error as Error)
      }
    }
  }
}
