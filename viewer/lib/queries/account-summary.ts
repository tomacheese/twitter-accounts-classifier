import type { PrismaClient } from '../../generated/prisma'

export type AccountSummaryView = 'recentlyChanged' | 'all'

export interface ListAccountSummariesFilters {
  labelKeys?: string[]
  minFindingSeverity?: string
}

export interface ListAccountSummariesInput {
  view: AccountSummaryView
  filters?: ListAccountSummariesFilters
  cursor?: string | null
  limit?: number
}

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

const MODEL_KEY = 'account_summary'
const DEFAULT_LIMIT = 25

/**
 * ReadModelPointer(modelKey: 'account_summary') が指す現在の generationId を取得する。
 * AccountSummaryCurrent は generationId ごとに全件書き込まれるため、これを介さずに
 * 直接クエリすると古い generation の残骸行を返しかねない。
 * @param prisma - Prisma クライアント
 * @returns 現在の generationId。ReadModelPointer が未生成なら null
 */
async function getCurrentGenerationId(prisma: PrismaClient): Promise<string | null> {
  const pointer = await prisma.readModelPointer.findUnique({ where: { modelKey: MODEL_KEY } })
  return pointer?.currentGenerationId ?? null
}

/**
 * `view: 'recentlyChanged'` は `lastClassificationChangedAt` 降順、
 * `view: 'all'` は `normalizedScreenName` 昇順で返す。
 * @param prisma - Prisma クライアント
 * @param input - view・filters・cursor・limit
 * @returns 1 ページ分のアカウント一覧
 */
export async function listAccountSummaries(
  prisma: PrismaClient,
  input: ListAccountSummariesInput,
): Promise<{ items: AccountSummaryListItem[]; generationId: string | null }> {
  const generationId = await getCurrentGenerationId(prisma)
  if (!generationId) return { items: [], generationId: null }

  const limit = input.limit ?? DEFAULT_LIMIT
  const where = {
    generationId,
    ...(input.filters?.labelKeys && input.filters.labelKeys.length > 0
      ? { activeLabelKeys: { hasSome: input.filters.labelKeys } }
      : {}),
  }

  const rows = await prisma.accountSummaryCurrent.findMany({
    where,
    orderBy:
      input.view === 'recentlyChanged'
        ? [{ lastClassificationChangedAt: 'desc' }, { accountId: 'desc' }]
        : [{ normalizedScreenName: 'asc' }, { accountId: 'asc' }],
    take: limit,
  })

  return {
    generationId,
    items: rows.map((row) => ({
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
