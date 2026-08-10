import type { PrismaClient } from '../../generated/prisma'
import { decodeCursor, encodeCursor } from '../pagination/keyset-cursor'

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
  currentStageKey: string | null
}

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

/** listOperationCycles の返り値。 */
export interface ListOperationCyclesResult {
  items: OperationCycleListItem[]
  nextCursor: string | null
}

/**
 * @param prisma - Prisma クライアント
 * @param input - filters・cursor・limit
 * @returns 新しい順に並べた Cycle 一覧と次ページの cursor
 */
export async function listOperationCycles(
  prisma: PrismaClient,
  input: { filters?: ListOperationCyclesFilters; cursor?: string; limit?: number } = {},
): Promise<ListOperationCyclesResult> {
  const kind = input.filters?.kind
  const attentionRequired = input.filters?.attentionRequired ?? false
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const filterHash = JSON.stringify({ kind, attentionRequired })
  const cursorValues = input.cursor ? decodeCursor(input.cursor, filterHash) : null

  const rows = await prisma.operationCycle.findMany({
    where: {
      ...(kind ? { kind } : {}),
      ...(attentionRequired ? { attentionRequired: true } : {}),
      ...(cursorValues
        ? {
            OR: [
              { triggeredAt: { lt: new Date(cursorValues[0]) } },
              { triggeredAt: new Date(cursorValues[0]), id: { lt: cursorValues[1] } },
            ],
          }
        : {}),
    },
    orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)

  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      attentionRequired: row.attentionRequired,
      triggeredAt: row.triggeredAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      currentStageKey: row.currentStageKey,
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor({ sortValues: [last.triggeredAt.toISOString(), last.id], filterHash })
        : null,
  }
}

/** Cycle を構成する Stage 1 件。 */
export interface OperationStageView {
  stageKey: string
  sequence: number
  requiredness: string
  status: string
  startedAt: Date | null
  finishedAt: Date | null
  errorCode: string | null
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
  /** account/action drill-down クエリが参照する CrawlRun/BlockRun の ID。 */
  sourceId: string
  stages: OperationStageView[]
}

/** Block Cycle 詳細に表示する、実行元アカウント単位の最新試行。 */
export interface BlockAccountRunView {
  id: string
  username: string
  status: string
  startedAt: Date
  finishedAt: Date | null
  candidatesCount: number
  blockedCount: number
  failedCount: number
  errorMessage: string | null
}

/** Block Cycle 専用の詳細表示。 */
export interface BlockOperationCycleDetailView extends OperationCycleDetailView {
  accountRuns: BlockAccountRunView[]
}

/** Weekly Review Cycle 専用の詳細表示。 */
export interface WeeklyReviewOperationCycleDetailView extends OperationCycleDetailView {
  /** Claude Code が生成した人間向け日本語サマリ。未生成なら null。 */
  findings: string | null
}

interface OperationCycleDetailRecord extends OperationCycleDetailView {
  sourceId: string
}

/**
 * @param prisma - Prisma クライアント
 * @param cycleId - 対象 OperationCycle の ID
 * @returns 4 Stage の timeline を sequence 順に含む Cycle 詳細。存在しなければ null
 */
async function getCycleDetail(
  prisma: PrismaClient,
  cycleId: string,
): Promise<OperationCycleDetailRecord | null> {
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
    sourceId: cycle.sourceId,
    stages: cycle.stages.map((stage) => ({
      stageKey: stage.stageKey,
      sequence: stage.sequence,
      requiredness: stage.requiredness,
      status: stage.status,
      startedAt: stage.startedAt,
      finishedAt: stage.finishedAt,
      errorCode: stage.errorCode,
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
): Promise<WeeklyReviewOperationCycleDetailView | null> {
  const detail = await getCycleDetail(prisma, cycleId)
  if (detail?.kind !== 'weekly_review') return null

  const run = await prisma.weeklyAnalysisRun.findUnique({
    where: { id: detail.sourceId },
    select: { findings: true },
  })

  return { ...detail, findings: run?.findings ?? null }
}

/**
 * @param prisma - Prisma クライアント
 * @param cycleId - 対象 OperationCycle の ID
 * @returns Cycle 詳細。存在しない、または kind が一致しなければ null
 */
export async function getBlockCycleDetail(
  prisma: PrismaClient,
  cycleId: string,
): Promise<BlockOperationCycleDetailView | null> {
  const detail = await getCycleDetail(prisma, cycleId)
  if (detail?.kind !== 'block') return null

  const accountRuns = await prisma.$queryRaw<BlockAccountRunView[]>`
    SELECT DISTINCT ON ("username")
      "id",
      "username",
      "status",
      "startedAt",
      "finishedAt",
      "candidatesCount",
      "blockedCount",
      "failedCount",
      "errorMessage"
    FROM "BlockAccountRun"
    WHERE "blockRunId" = ${detail.sourceId}
    ORDER BY "username", "startedAt" DESC, "id" DESC
  `

  return { ...detail, accountRuns }
}
