import type { PrismaClient } from '../generated/prisma'

export type StageStatus =
  'waiting' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'delayed' | 'stale' | 'unknown'

export type CycleStatus =
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'delayed'
  | 'stale'
  | 'cancelled'
  | 'unknown'

const ANALYSIS_WORK_ITEM_STAGE_KINDS = [
  'label_metrics',
  'finding_generation',
  'read_model_refresh',
] as const

/**
 * 起点 Stage (crawl) が成功しても、必須後続 Stage が failed/未完了なら
 * succeeded にせず partial とする。Crawl 成功後の後続失敗を成功として
 * 表示しないための唯一の判定箇所として、この関数へ集約する。
 * @param requiredStages - 先頭が crawl Stage の状態列
 * @returns Cycle 全体の状態
 */
export function deriveCycleStatus(requiredStages: StageStatus[]): CycleStatus {
  if (requiredStages.includes('failed')) {
    return requiredStages[0] === 'succeeded' ? 'partial' : 'failed'
  }
  if (requiredStages.includes('running')) return 'running'
  if (requiredStages.every((status) => status === 'succeeded')) return 'succeeded'
  if (requiredStages.includes('stale')) return 'stale'
  if (requiredStages.includes('delayed')) return 'delayed'
  if (requiredStages.includes('unknown')) return 'unknown'
  return 'scheduled'
}

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
 * crawl 完了時に必ず AnalysisWorkItem が enqueue される設計 (Task 9) を前提に、
 * WorkItem 自体が存在しないことは「本来行われるはずの処理が欠落した」状態とみなし
 * failed として扱う。これにより Operations 画面が欠落を見逃さず attention として拾える。
 * @param prisma - Prisma クライアント
 * @param kind - AnalysisWorkItem.kind
 * @param crawlRunId - 起点となった CrawlRun の ID
 * @returns 対応する Stage の状態
 */
async function deriveWorkItemStageStatus(
  prisma: PrismaClient,
  kind: string,
  crawlRunId: string,
): Promise<StageStatus> {
  const workItem = await prisma.analysisWorkItem.findUnique({
    where: {
      kind_triggerType_triggerId: { kind, triggerType: 'crawl_run', triggerId: crawlRunId },
    },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
  })
  if (!workItem) return 'failed'

  const latestRun = workItem.runs.at(0)
  if (latestRun) {
    if (latestRun.status === 'succeeded') return 'succeeded'
    if (latestRun.status === 'failed') return 'failed'
    return 'running'
  }

  return workItem.status === 'running' ? 'running' : 'waiting'
}

export interface BuildOrUpdateCrawlCycleInput {
  crawlRunId: string
}

/**
 * CrawlRun 1 件を起点に、crawl・label_metrics・finding_generation・read_model_refresh の
 * 4 Stage を upsert し、Cycle 全体の状態を再計算する。Task 17 (read model 生成) の最後で
 * 呼ばれ、Operations 画面はこの Cycle/Stage のみを読む。
 * @param prisma - Prisma クライアント
 * @param input - 対象 CrawlRun
 */
export async function buildOrUpdateCrawlCycle(
  prisma: PrismaClient,
  input: BuildOrUpdateCrawlCycleInput,
): Promise<void> {
  const crawlRun = await prisma.crawlRun.findUniqueOrThrow({ where: { id: input.crawlRunId } })

  const stages: { stageKey: string; status: StageStatus }[] = [
    { stageKey: 'crawl', status: deriveCrawlStageStatus(crawlRun.status) },
  ]
  for (const kind of ANALYSIS_WORK_ITEM_STAGE_KINDS) {
    stages.push({
      stageKey: kind,
      status: await deriveWorkItemStageStatus(prisma, kind, input.crawlRunId),
    })
  }

  const cycleStatus = deriveCycleStatus(stages.map((stage) => stage.status))
  const attentionRequired =
    cycleStatus === 'partial' || cycleStatus === 'failed' || cycleStatus === 'stale'

  const cycle = await prisma.operationCycle.upsert({
    where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: input.crawlRunId } },
    create: {
      kind: 'crawl_cycle',
      sourceType: 'crawl_run',
      sourceId: input.crawlRunId,
      triggeredAt: crawlRun.startedAt,
      startedAt: crawlRun.startedAt,
      finishedAt: crawlRun.finishedAt,
      status: cycleStatus,
      attentionRequired,
      currentStageKey: stages.find((stage) => stage.status !== 'succeeded')?.stageKey,
      modelVersion: '1',
    },
    update: {
      status: cycleStatus,
      finishedAt: crawlRun.finishedAt,
      attentionRequired,
      currentStageKey: stages.find((stage) => stage.status !== 'succeeded')?.stageKey,
    },
  })

  let sequence = 0
  for (const stage of stages) {
    sequence++
    const isTerminal = stage.status === 'succeeded' || stage.status === 'failed'
    await prisma.operationStage.upsert({
      where: { cycleId_stageKey: { cycleId: cycle.id, stageKey: stage.stageKey } },
      create: {
        cycleId: cycle.id,
        stageKey: stage.stageKey,
        sequence,
        requiredness: 'required',
        status: stage.status,
        sourceType: stage.stageKey === 'crawl' ? 'crawl_run' : 'analysis_work_item',
        sourceId: input.crawlRunId,
        finishedAt: isTerminal ? new Date() : undefined,
      },
      update: {
        status: stage.status,
        finishedAt: isTerminal ? new Date() : undefined,
      },
    })
  }
}
