import type { PrismaClient } from '../../generated/prisma'
import { decodeCursor, encodeCursor } from '../pagination/keyset-cursor'

const MODEL_KEY = 'block_relation'
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const TIMELINE_LIMIT = 10

/** Block 関係一覧の絞り込み条件。 */
export interface ListBlockRelationsFilters {
  status?: string
}

/** Block 関係一覧の 1 行。 */
export interface BlockRelationListItem {
  blockId: string
  normalizedBlockerScreenName: string
  normalizedBlockedScreenName: string
  status: string
  statusChangedAt: Date
  activeFindingCount: number
  highestFindingSeverity: string | null
}

/** listBlockRelations の返り値。 */
export interface ListBlockRelationsResult {
  items: BlockRelationListItem[]
  nextCursor: string | null
  generationId: string | null
}

/**
 * @param prisma - Prisma クライアント
 * @returns block_relation read model の現在の generationId
 */
async function getCurrentGenerationId(prisma: PrismaClient): Promise<string | null> {
  const pointer = await prisma.readModelPointer.findUnique({ where: { modelKey: MODEL_KEY } })
  return pointer?.currentGenerationId ?? null
}

/**
 * `status: 'active'` を既定 filter とする Block 関係一覧を取得する。
 * @param prisma - Prisma クライアント
 * @param input - filters・cursor・limit
 * @returns Block 関係一覧
 */
export async function listBlockRelations(
  prisma: PrismaClient,
  input: { filters?: ListBlockRelationsFilters; cursor?: string; limit?: number } = {},
): Promise<ListBlockRelationsResult> {
  const generationId = await getCurrentGenerationId(prisma)
  if (!generationId) return { items: [], nextCursor: null, generationId: null }

  const status = input.filters?.status ?? 'active'
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const filterHash = JSON.stringify({ status })
  const cursorValues = input.cursor ? decodeCursor(input.cursor, filterHash) : null

  const rows = await prisma.blockRelationCurrent.findMany({
    where: {
      generationId,
      status,
      ...(cursorValues
        ? {
            OR: [
              { statusChangedAt: { lt: new Date(cursorValues[0]) } },
              {
                statusChangedAt: new Date(cursorValues[0]),
                blockId: { lt: cursorValues[1] },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ statusChangedAt: 'desc' }, { blockId: 'desc' }],
    take: limit + 1,
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          sortValues: [last.statusChangedAt.toISOString(), last.blockId],
          filterHash,
        })
      : null

  return {
    items: page.map((row) => ({
      blockId: row.blockId,
      normalizedBlockerScreenName: row.normalizedBlockerScreenName,
      normalizedBlockedScreenName: row.normalizedBlockedScreenName,
      status: row.status,
      statusChangedAt: row.statusChangedAt,
      activeFindingCount: row.activeFindingCount,
      highestFindingSeverity: row.highestFindingSeverity,
    })),
    nextCursor,
    generationId,
  }
}

/** Block 関係の当事者アカウント。 */
export interface BlockRelationAccountView {
  id: string
  screenName: string
  displayName: string
}

/** Block 関係の状態遷移 1 件。 */
export interface BlockRelationTimelineItem {
  id: string
  fromStatus: string | null
  toStatus: string
  changedAt: Date
}

/** Block 関係に紐づく Finding の要約。 */
export interface BlockRelationFindingView {
  id: string
  type: string
  currentSeverity: string
  status: string
}

/** Block 関係詳細の表示内容。 */
export interface BlockRelationDetailView {
  id: string
  blocker: BlockRelationAccountView
  blocked: BlockRelationAccountView
  status: string
  firstSeenAt: Date
  lastSeenAt: Date
  lastCheckedAt: Date
  missingSinceAt: Date | null
  resolvedAt: Date | null
  consecutiveMissingCount: number
  sourceKind: string
  timeline: BlockRelationTimelineItem[]
  relatedFindings: BlockRelationFindingView[]
}

/**
 * Block 関係の詳細を取得する。
 * Timeline は初期表示に必要な最新分のみ取得し、それ以前は取得しない。
 * OperationCycle は Block 単位の実行記録と紐付く列を持たないため、関連 Cycle は返さない。
 * @param prisma - Prisma クライアント
 * @param blockId - 対象 Block の ID
 * @returns Block 関係詳細。存在しなければ null
 */
export async function getBlockRelationDetail(
  prisma: PrismaClient,
  blockId: string,
): Promise<BlockRelationDetailView | null> {
  const block = await prisma.block.findUnique({
    where: { id: blockId },
    include: { blocker: true, blocked: true },
  })
  if (!block) return null

  const [timeline, relatedFindingLinks] = await Promise.all([
    prisma.blockStateChange.findMany({
      where: { blockId },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: TIMELINE_LIMIT,
    }),
    prisma.findingEntityLink.findMany({
      where: { entityType: 'block', entityId: blockId },
      include: { finding: true },
    }),
  ])

  return {
    id: block.id,
    blocker: {
      id: block.blocker.id,
      screenName: block.blocker.screenName,
      displayName: block.blocker.displayName,
    },
    blocked: {
      id: block.blocked.id,
      screenName: block.blocked.screenName,
      displayName: block.blocked.displayName,
    },
    status: block.status,
    firstSeenAt: block.firstSeenAt,
    lastSeenAt: block.lastSeenAt,
    lastCheckedAt: block.lastCheckedAt,
    missingSinceAt: block.missingSinceAt,
    resolvedAt: block.resolvedAt,
    consecutiveMissingCount: block.consecutiveMissingCount,
    sourceKind: block.sourceKind,
    timeline: timeline.map((change) => ({
      id: change.id,
      fromStatus: change.fromStatus,
      toStatus: change.toStatus,
      changedAt: change.changedAt,
    })),
    relatedFindings: relatedFindingLinks.map((link) => ({
      id: link.finding.id,
      type: link.finding.type,
      currentSeverity: link.finding.currentSeverity,
      status: link.finding.status,
    })),
  }
}
