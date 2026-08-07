import type { PrismaClient } from '../../generated/prisma'

export type OperationCycleKind = 'crawl' | 'weekly_review' | 'block'

export interface ListOperationCyclesFilters {
  kind?: OperationCycleKind
  attentionRequired?: boolean
}

export interface OperationCycleListItem {
  id: string
  kind: string
  status: string
  attentionRequired: boolean
  triggeredAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

const DEFAULT_LIMIT = 30
// attentionRequired filter が対象とする Cycle 状態。spec の「partial/failed/stale/unknown を含む」定義。
const ATTENTION_STATUSES = new Set(['partial', 'failed', 'stale', 'unknown'])

/**
 * @param prisma - Prisma クライアント
 * @param input - filters・limit
 * @returns 直近の Cycle 一覧 (既定 30 件)
 */
export async function listOperationCycles(
  prisma: PrismaClient,
  input: { filters?: ListOperationCyclesFilters; limit?: number } = {},
): Promise<OperationCycleListItem[]> {
  const rows = await prisma.operationCycle.findMany({
    where: {
      ...(input.filters?.kind ? { kind: input.filters.kind } : {}),
      ...(input.filters?.attentionRequired ? { attentionRequired: true } : {}),
    },
    orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }],
    take: input.limit ?? DEFAULT_LIMIT,
  })

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    attentionRequired: row.attentionRequired,
    triggeredAt: row.triggeredAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }))
}

/**
 * @param status - 対象 Cycle の status
 * @returns spec の attentionRequired filter (partial/failed/stale/unknown) に該当すれば true
 */
export function isAttentionRequiredStatus(status: string): boolean {
  return ATTENTION_STATUSES.has(status)
}

export interface OperationStageView {
  stageKey: string
  sequence: number
  requiredness: string
  status: string
  startedAt: Date | null
  finishedAt: Date | null
  errorSummary: string | null
}

export interface OperationCycleDetailView {
  id: string
  kind: string
  status: string
  attentionRequired: boolean
  triggeredAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  stages: OperationStageView[]
}

/**
 * @param prisma - Prisma クライアント
 * @param cycleId - 対象 OperationCycle の ID
 * @returns 4 Stage の timeline を sequence 順に含む Cycle 詳細。存在しなければ null
 */
async function getCycleDetail(
  prisma: PrismaClient,
  cycleId: string,
): Promise<OperationCycleDetailView | null> {
  const cycle = await prisma.operationCycle.findUnique({
    where: { id: cycleId },
    include: { stages: { orderBy: [{ sequence: 'asc' }] } },
  })
  if (!cycle) return null

  return {
    id: cycle.id,
    kind: cycle.kind,
    status: cycle.status,
    attentionRequired: cycle.attentionRequired,
    triggeredAt: cycle.triggeredAt,
    startedAt: cycle.startedAt,
    finishedAt: cycle.finishedAt,
    stages: cycle.stages.map((stage) => ({
      stageKey: stage.stageKey,
      sequence: stage.sequence,
      requiredness: stage.requiredness,
      status: stage.status,
      startedAt: stage.startedAt,
      finishedAt: stage.finishedAt,
      errorSummary: stage.errorSummary,
    })),
  }
}

/**
 * `kind: 'crawl'` の Cycle 詳細を取得する。
 * @param prisma - Prisma クライアント
 * @param cycleId - 対象 OperationCycle の ID
 * @returns Cycle 詳細。存在しない、または kind が一致しなければ null
 */
export async function getCrawlCycleDetail(
  prisma: PrismaClient,
  cycleId: string,
): Promise<OperationCycleDetailView | null> {
  const detail = await getCycleDetail(prisma, cycleId)
  return detail?.kind === 'crawl' ? detail : null
}

/**
 * `kind: 'weekly_review'` の Cycle 詳細を取得する。
 * @param prisma - Prisma クライアント
 * @param cycleId - 対象 OperationCycle の ID
 * @returns Cycle 詳細。存在しない、または kind が一致しなければ null
 */
export async function getWeeklyReviewCycleDetail(
  prisma: PrismaClient,
  cycleId: string,
): Promise<OperationCycleDetailView | null> {
  const detail = await getCycleDetail(prisma, cycleId)
  return detail?.kind === 'weekly_review' ? detail : null
}

/**
 * `kind: 'block'` の Cycle 詳細を取得する。
 * @param prisma - Prisma クライアント
 * @param cycleId - 対象 OperationCycle の ID
 * @returns Cycle 詳細。存在しない、または kind が一致しなければ null
 */
export async function getBlockCycleDetail(
  prisma: PrismaClient,
  cycleId: string,
): Promise<OperationCycleDetailView | null> {
  const detail = await getCycleDetail(prisma, cycleId)
  return detail?.kind === 'block' ? detail : null
}
