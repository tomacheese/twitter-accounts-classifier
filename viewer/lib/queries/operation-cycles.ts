import type { PrismaClient } from '../../generated/prisma'

/** OperationCycle の種別。 */
export type OperationCycleKind = 'crawl' | 'weekly_review' | 'block'

/** Cycle 一覧の絞り込み条件。 */
export interface ListOperationCyclesFilters {
  kind?: OperationCycleKind
  attentionRequired?: boolean
}

/** Cycle 一覧の 1 行。 */
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

/**
 * @param prisma - Prisma クライアント
 * @param input - filters・limit
 * @returns 新しい順に並べた Cycle 一覧
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

/** Cycle を構成する Stage 1 件。 */
export interface OperationStageView {
  stageKey: string
  sequence: number
  requiredness: string
  status: string
  startedAt: Date | null
  finishedAt: Date | null
  errorSummary: string | null
}

/** Cycle 詳細の表示内容。 */
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
