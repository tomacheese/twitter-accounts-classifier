import type { PrismaClient } from '../../generated/prisma'
import type { ReadModelFreshnessStatus } from '../api-response'
import { decodeCursor, encodeCursor } from '../pagination/keyset-cursor'
import {
  getReadModelMeta,
  getReadModelReadiness,
  type ReadModelReadinessStatus,
} from '../read-model-meta'

/** アカウント一覧の表示順を決める view。 */
export type AccountSummaryView = 'recentlyChanged' | 'all'

/** アカウント一覧の絞り込み条件。 */
export interface ListAccountSummariesFilters {
  labelKeys?: string[]
  minFindingSeverity?: string
}

/** listAccountSummaries の入力。 */
export interface ListAccountSummariesInput {
  view: AccountSummaryView
  filters?: ListAccountSummariesFilters
  cursor?: string | null
  limit?: number
}

/** アカウント一覧の 1 行。 */
export interface AccountSummaryListItem {
  accountId: string
  normalizedScreenName: string
  normalizedDisplayName: string
  activeLabelKeys: string[]
  activeLabelCount: number
  lastClassificationChangedAt: Date | null
  activeFindingCount: number
  highestFindingSeverity: string | null
}

/** listAccountSummaries の返り値。 */
export interface ListAccountSummariesResult {
  items: AccountSummaryListItem[]
  nextCursor: string | null
  generationId: string | null
  freshnessStatus: ReadModelFreshnessStatus
  readiness: ReadModelReadinessStatus
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

// severity は文字列カラムのため、比較演算では閾値以上を表現できない。
// 順序を明示した配列から候補集合を作り、`in` で絞り込む。
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical']

/**
 * @param minSeverity - 下限とする severity
 * @returns 下限以上の severity 一覧。未知の値なら null
 */
function resolveSeverityCandidates(minSeverity: string): string[] | null {
  const index = SEVERITY_ORDER.indexOf(minSeverity)
  return index === -1 ? null : SEVERITY_ORDER.slice(index)
}

/**
 * `view: 'recentlyChanged'` は `lastClassificationChangedAt` 降順、
 * `view: 'all'` は `normalizedScreenName` 昇順で返す。
 * 降順側は NULLS FIRST となる索引順をそのまま使うため、
 * cursor 条件も null 行を先に消化してから日時比較へ移る形にしている。
 * @param prisma - Prisma クライアント
 * @param input - view・filters・cursor・limit
 * @returns 1 ページ分のアカウント一覧と次ページの cursor
 */
export async function listAccountSummaries(
  prisma: PrismaClient,
  input: ListAccountSummariesInput,
): Promise<ListAccountSummariesResult> {
  const readiness = await getReadModelReadiness(prisma)
  if (readiness.accounts !== 'ready') {
    return {
      items: [],
      nextCursor: null,
      generationId: null,
      freshnessStatus: 'unknown',
      readiness: readiness.accounts,
    }
  }
  const { freshnessStatus } = await getReadModelMeta(prisma, 'account_summary_latest')

  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const labelKeys = input.filters?.labelKeys ?? []
  const minFindingSeverity = input.filters?.minFindingSeverity
  const severityCandidates = minFindingSeverity
    ? resolveSeverityCandidates(minFindingSeverity)
    : null

  const filterHash = JSON.stringify({
    view: input.view,
    labelKeys: [...labelKeys].toSorted(),
    minFindingSeverity: minFindingSeverity ?? null,
  })
  const cursorValues = input.cursor ? decodeCursor(input.cursor, filterHash) : null

  const cursorWhere = ((): object => {
    if (!cursorValues || cursorValues.length < 2) return {}
    const [first, accountId] = cursorValues
    if (input.view === 'all') {
      return {
        OR: [
          { normalizedScreenName: { gt: first } },
          { normalizedScreenName: first, accountId: { gt: accountId } },
        ],
      }
    }
    if (!first) {
      return {
        OR: [
          { lastClassificationChangedAt: null, accountId: { lt: accountId } },
          { lastClassificationChangedAt: { not: null } },
        ],
      }
    }
    const changedAt = new Date(first)
    return {
      OR: [
        { lastClassificationChangedAt: { lt: changedAt } },
        { lastClassificationChangedAt: changedAt, accountId: { lt: accountId } },
      ],
    }
  })()

  const rows = await prisma.accountSummaryLatest.findMany({
    where: {
      ...(labelKeys.length > 0 ? { activeLabelKeys: { hasSome: labelKeys } } : {}),
      ...(severityCandidates ? { highestFindingSeverity: { in: severityCandidates } } : {}),
      ...cursorWhere,
    },
    orderBy:
      input.view === 'recentlyChanged'
        ? [{ lastClassificationChangedAt: 'desc' }, { accountId: 'desc' }]
        : [{ normalizedScreenName: 'asc' }, { accountId: 'asc' }],
    take: limit + 1,
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          sortValues:
            input.view === 'all'
              ? [last.normalizedScreenName, last.accountId]
              : [last.lastClassificationChangedAt?.toISOString() ?? '', last.accountId],
          filterHash,
        })
      : null

  return {
    generationId: null,
    freshnessStatus,
    readiness: readiness.accounts,
    nextCursor,
    items: page.map((row) => ({
      accountId: row.accountId,
      normalizedScreenName: row.normalizedScreenName,
      normalizedDisplayName: row.normalizedDisplayName,
      activeLabelKeys: row.activeLabelKeys,
      activeLabelCount: row.activeLabelCount,
      lastClassificationChangedAt: row.lastClassificationChangedAt,
      activeFindingCount: row.activeFindingCount,
      highestFindingSeverity: row.highestFindingSeverity,
    })),
  }
}
