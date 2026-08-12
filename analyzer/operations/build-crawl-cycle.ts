import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import {
  applyUpstreamBlocking,
  deleteObsoleteOperationStages,
  deriveWorkItemStage,
  NEVER_ENQUEUED_ERROR_SUMMARY,
  upsertCycleWithStages,
  type CycleStageInput,
  type StageStatus,
  type WorkItemStage,
} from './cycle-common'

const CRAWL_CYCLE_STAGE_KEYS = ['crawl', 'label_aggregate_refresh']

const logger = Logger.configure('analyzer:build-crawl-cycle')

/**
 * @param crawlRunStatus - CrawlRun.status の値
 * @returns crawl Stage の状態
 */
function deriveCrawlStageStatus(crawlRunStatus: string): StageStatus {
  if (crawlRunStatus === 'running') return 'running'
  if (crawlRunStatus === 'success') return 'succeeded'
  if (crawlRunStatus === 'partial') return 'partial'
  if (crawlRunStatus === 'failed') return 'failed'
  return 'unknown'
}

/**
 * 廃止済み read_model_refresh の実行履歴が残る旧 v1 cycle かどうかを判定する。
 * 旧 pipeline 時代の CrawlRun は label_aggregate_refresh の WorkItem を持たないため、
 * 素通りさせて再構築すると新規の phantom failure を生んでしまう。
 * 読み取りのみ行い、判定結果に応じて呼び出し元が書き込みを止める。
 * @param prisma - Prisma クライアント
 * @param crawlRunId - 対象 CrawlRun の ID
 * @param labelAggregateRefreshStage - 呼び出し元が既に取得済みの label_aggregate_refresh Stage
 * @returns 旧 v1 cycle なら true
 */
async function isLegacyReadModelRefreshCycle(
  prisma: PrismaClient,
  crawlRunId: string,
  labelAggregateRefreshStage: WorkItemStage,
): Promise<boolean> {
  const readModelRefreshStages = await prisma.operationStage.findMany({
    where: {
      stageKey: 'read_model_refresh',
      cycle: { sourceType: 'crawl_run', sourceId: crawlRunId },
    },
    select: { analysisRunId: true, errorSummary: true },
  })
  // phantom 条件 (analysisRunId: null かつ未 enqueue エラー概要) の否定を SQL の WHERE 句に
  // 組み込むと、errorSummary が null (phantom 文字列とは無関係) の行が三値論理で
  // 除外されてしまうため、判定はここでアプリケーション側で行う。
  const hasLegacyStage = readModelRefreshStages.some(
    (stage) =>
      !(stage.analysisRunId === null && stage.errorSummary === NEVER_ENQUEUED_ERROR_SUMMARY),
  )
  return hasLegacyStage && !labelAggregateRefreshStage.workItemExists
}

/**
 * buildOrUpdateCrawlCycle の入力。
 */
export interface BuildOrUpdateCrawlCycleInput {
  /** 起点となる CrawlRun の ID。 */
  crawlRunId: string
}

/**
 * CrawlRun 1 件を起点に 2 Stage を upsert し、Cycle 全体の状態を再計算する。
 * Operations 画面は正本テーブルではなくこの Cycle/Stage のみを読む。
 * @param prisma - Prisma クライアント
 * @param input - 対象 CrawlRun
 */
export async function buildOrUpdateCrawlCycle(
  prisma: PrismaClient,
  input: BuildOrUpdateCrawlCycleInput,
): Promise<void> {
  const labelAggregateRefreshStage = await deriveWorkItemStage(
    prisma,
    'label_aggregate_refresh',
    'crawl_run',
    input.crawlRunId,
  )

  if (await isLegacyReadModelRefreshCycle(prisma, input.crawlRunId, labelAggregateRefreshStage)) {
    logger.info(`legacy read_model_refresh cycle, skip rebuild: crawlRunId=${input.crawlRunId}`)
    return
  }

  const crawlRun = await prisma.crawlRun.findUniqueOrThrow({ where: { id: input.crawlRunId } })

  const crawlStageStatus = deriveCrawlStageStatus(crawlRun.status)
  const labelAggregateRefreshStatus = applyUpstreamBlocking(
    labelAggregateRefreshStage,
    crawlStageStatus,
  )
  const stages: CycleStageInput[] = [
    {
      stageKey: 'crawl',
      status: crawlStageStatus,
      sourceType: 'crawl_run',
      sourceId: crawlRun.id,
      startedAt: crawlRun.startedAt,
      finishedAt: crawlRun.finishedAt ?? undefined,
    },
    {
      stageKey: 'label_aggregate_refresh',
      sourceType: 'analysis_work_item',
      sourceId: crawlRun.id,
      ...labelAggregateRefreshStatus,
    },
  ]

  await prisma.$transaction(async (tx) => {
    const { cycleId } = await upsertCycleWithStages(tx as unknown as PrismaClient, {
      kind: 'crawl',
      sourceType: 'crawl_run',
      sourceId: crawlRun.id,
      triggeredAt: crawlRun.startedAt,
      startedAt: crawlRun.startedAt,
      finishedAt: crawlRun.finishedAt ?? undefined,
      stages,
      modelVersion: '2',
    })
    await deleteObsoleteOperationStages(
      tx as unknown as PrismaClient,
      cycleId,
      CRAWL_CYCLE_STAGE_KEYS,
    )
  })
}
