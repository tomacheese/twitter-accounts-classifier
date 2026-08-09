import type { PrismaClient } from '../generated/prisma'
import {
  deriveWorkItemStage,
  upsertCycleWithStages,
  type CycleStageInput,
  type StageStatus,
} from './cycle-common'

const ANALYSIS_WORK_ITEM_STAGE_KINDS = ['label_aggregate_refresh', 'read_model_refresh'] as const

/**
 * @param crawlRunStatus - CrawlRun.status の値
 * @returns crawl Stage の状態
 */
function deriveCrawlStageStatus(crawlRunStatus: string): StageStatus {
  if (crawlRunStatus === 'running') return 'running'
  if (crawlRunStatus === 'success' || crawlRunStatus === 'partial') return 'succeeded'
  if (crawlRunStatus === 'failed') return 'failed'
  return 'unknown'
}

/**
 * buildOrUpdateCrawlCycle の入力。
 */
export interface BuildOrUpdateCrawlCycleInput {
  /** 起点となる CrawlRun の ID。 */
  crawlRunId: string
}

/**
 * CrawlRun 1 件を起点に 4 Stage を upsert し、Cycle 全体の状態を再計算する。
 * Operations 画面は正本テーブルではなくこの Cycle/Stage のみを読む。
 * @param prisma - Prisma クライアント
 * @param input - 対象 CrawlRun
 */
export async function buildOrUpdateCrawlCycle(
  prisma: PrismaClient,
  input: BuildOrUpdateCrawlCycleInput,
): Promise<void> {
  const crawlRun = await prisma.crawlRun.findUniqueOrThrow({ where: { id: input.crawlRunId } })

  const stages: CycleStageInput[] = [
    {
      stageKey: 'crawl',
      status: deriveCrawlStageStatus(crawlRun.status),
      sourceType: 'crawl_run',
      sourceId: crawlRun.id,
      startedAt: crawlRun.startedAt,
      finishedAt: crawlRun.finishedAt ?? undefined,
    },
  ]
  for (const kind of ANALYSIS_WORK_ITEM_STAGE_KINDS) {
    const stage = await deriveWorkItemStage(prisma, kind, 'crawl_run', input.crawlRunId)
    // processReadModelRefresh() は partial/failed CrawlRun では read model 公開を
    // 見送って正常終了するため、WorkItem 自体は succeeded になる。この succeeded を
    // そのまま表示すると必須後続処理が完了していないことが Operations から見えなくなるため、
    // ここで skipped + 理由へ差し替える (WorkItem の実状態は変更しない)。
    const isReadModelRefreshSkippedForIncompleteCrawl =
      kind === 'read_model_refresh' && crawlRun.status !== 'success' && stage.status === 'succeeded'
    stages.push({
      stageKey: kind,
      sourceType: 'analysis_work_item',
      sourceId: crawlRun.id,
      ...stage,
      ...(isReadModelRefreshSkippedForIncompleteCrawl
        ? {
            status: 'skipped' as StageStatus,
            errorSummary: `crawl run is ${crawlRun.status}: read model refresh skipped`,
          }
        : {}),
    })
  }

  await upsertCycleWithStages(prisma, {
    kind: 'crawl',
    sourceType: 'crawl_run',
    sourceId: crawlRun.id,
    triggeredAt: crawlRun.startedAt,
    startedAt: crawlRun.startedAt,
    finishedAt: crawlRun.finishedAt ?? undefined,
    stages,
  })
}
