import type { PrismaClient } from '../generated/prisma'
import {
  applyUpstreamBlocking,
  deleteObsoleteOperationStages,
  deriveWorkItemStage,
  NEVER_ENQUEUED_ERROR_SUMMARY,
  upsertCycleWithStages,
  type CycleStageInput,
  type StageStatus,
} from './cycle-common'

const ANALYSIS_WORK_ITEM_STAGE_KINDS = ['label_aggregate_refresh'] as const
const CRAWL_CYCLE_STAGE_KEYS = ['crawl', ...ANALYSIS_WORK_ITEM_STAGE_KINDS]

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
 * 旧 pipeline 時代の CrawlRun には label_aggregate_refresh の WorkItem が
 * 存在しないため、この関数を素通りさせて再構築すると新規の phantom failure を
 * 生んでしまう。読み取りのみ行い、判定結果に応じて呼び出し元が書き込みを止める。
 * @param prisma - Prisma クライアント
 * @param crawlRunId - 対象 CrawlRun の ID
 * @returns 旧 v1 cycle なら true
 */
async function isLegacyReadModelRefreshCycle(
  prisma: PrismaClient,
  crawlRunId: string,
): Promise<boolean> {
  const [readModelRefreshStages, currentWorkItem] = await Promise.all([
    prisma.operationStage.findMany({
      where: {
        stageKey: 'read_model_refresh',
        cycle: { sourceType: 'crawl_run', sourceId: crawlRunId },
      },
    }),
    prisma.analysisWorkItem.findUnique({
      where: {
        kind_triggerType_triggerId: {
          kind: 'label_aggregate_refresh',
          triggerType: 'crawl_run',
          triggerId: crawlRunId,
        },
      },
    }),
  ])
  // phantom 条件 (analysisRunId: null かつ未 enqueue エラー概要) の否定を SQL の WHERE 句に
  // 組み込むと、errorSummary が null (phantom 文字列とは無関係) の行が三値論理で
  // 除外されてしまうため、判定はここでアプリケーション側で行う。
  const hasLegacyStage = readModelRefreshStages.some(
    (stage) =>
      !(stage.analysisRunId === null && stage.errorSummary === NEVER_ENQUEUED_ERROR_SUMMARY),
  )
  return hasLegacyStage && currentWorkItem === null
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
  if (await isLegacyReadModelRefreshCycle(prisma, input.crawlRunId)) return

  const crawlRun = await prisma.crawlRun.findUniqueOrThrow({ where: { id: input.crawlRunId } })

  const crawlStageStatus = deriveCrawlStageStatus(crawlRun.status)
  const stages: CycleStageInput[] = [
    {
      stageKey: 'crawl',
      status: crawlStageStatus,
      sourceType: 'crawl_run',
      sourceId: crawlRun.id,
      startedAt: crawlRun.startedAt,
      finishedAt: crawlRun.finishedAt ?? undefined,
    },
  ]

  let previousStageStatus: StageStatus = crawlStageStatus
  for (const kind of ANALYSIS_WORK_ITEM_STAGE_KINDS) {
    const rawStage = await deriveWorkItemStage(prisma, kind, 'crawl_run', input.crawlRunId)
    const stage = applyUpstreamBlocking(rawStage, previousStageStatus)

    stages.push({
      stageKey: kind,
      sourceType: 'analysis_work_item',
      sourceId: crawlRun.id,
      ...stage,
    })
    previousStageStatus = stage.status
  }

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
