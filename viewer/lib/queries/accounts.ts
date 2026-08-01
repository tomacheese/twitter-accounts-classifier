import { Prisma, type PrismaClient } from '../../generated/prisma'

export type AccountSortField = 'followersCount' | 'tweetCount' | 'lastCrawledAt'
export type SortDirection = 'asc' | 'desc'

/**
 * The label filter, sort, and pagination parameters for {@link listAccounts}.
 */
export interface AccountListFilters {
  labelKeys?: string[]
  page: number
  pageSize: number
  sortBy: AccountSortField
  sortDirection: SortDirection
}

/**
 * A single account row rendered in the account list page.
 */
export interface AccountListItem {
  id: string
  screenName: string
  displayName: string
  followersCount: number
  tweetCount: number
  lastCrawledAt: Date
  isBlueVerified: boolean
  activeLabelKeys: string[]
}

/**
 * A page of account list items plus the total number of matches, for pagination.
 */
export interface AccountListResult {
  items: AccountListItem[]
  totalCount: number
}

interface MatchingAccountIdRow {
  accountId: string
}

interface ActiveLabelRow {
  accountId: string
  key: string
}

/**
 * 指定したラベルキーのいずれかで最新評価が `true` のアカウント ID を返す。
 * `AccountLabelLatest` を読む (テーブルの設計意図は prisma/schema.prisma の
 * AccountLabelLatest コメントを参照)。
 * @param prisma - クエリを実行する Prisma クライアント
 * @param labelKeys - マッチ対象のラベルキー (OR 条件)
 * @returns 一致したアカウント ID
 */
async function findAccountIdsWithAnyLabel(
  prisma: PrismaClient,
  labelKeys: string[],
): Promise<string[]> {
  const rows = await prisma.$queryRaw<MatchingAccountIdRow[]>`
    SELECT DISTINCT ll."accountId" AS "accountId"
    FROM "AccountLabelLatest" ll
    JOIN "LabelDefinition" ld ON ld.id = ll."labelDefinitionId"
    WHERE ll.value = true AND ld.key IN (${Prisma.join(labelKeys)})
  `
  return rows.map((row) => row.accountId)
}

/**
 * 指定した各アカウントについて、有効な (最新評価が `true` の) ラベルキーを
 * 読み込む。アカウント一覧のラベルバッジ表示用。`AccountLabelLatest` を読む
 * 点は {@link findAccountIdsWithAnyLabel} と同じ。
 * @param prisma - クエリを実行する Prisma クライアント
 * @param accountIds - 有効ラベルを読み込む対象のアカウント
 * @returns アカウント ID から有効ラベルキー一覧へのマップ
 */
async function getActiveLabelKeysByAccount(
  prisma: PrismaClient,
  accountIds: string[],
): Promise<Map<string, string[]>> {
  if (accountIds.length === 0) {
    return new Map()
  }

  const rows = await prisma.$queryRaw<ActiveLabelRow[]>`
    SELECT ll."accountId" AS "accountId", ld.key AS "key"
    FROM "AccountLabelLatest" ll
    JOIN "LabelDefinition" ld ON ld.id = ll."labelDefinitionId"
    WHERE ll.value = true AND ll."accountId" IN (${Prisma.join(accountIds)})
  `

  const map = new Map<string, string[]>()
  for (const row of rows) {
    const keys = map.get(row.accountId) ?? []
    keys.push(row.key)
    map.set(row.accountId, keys)
  }
  return map
}

/**
 * Loads every registered label key, for populating the Accounts page's label
 * filter control. Deliberately lighter than {@link getLabelDistribution}
 * (dashboard.ts): the filter only needs the key list, not the true/total
 * counts, which would otherwise force a full `AccountLabel` scan just to
 * render checkboxes.
 * @param prisma - the Prisma client to query
 * @returns every label key, ordered alphabetically
 */
export async function getLabelKeys(prisma: PrismaClient): Promise<string[]> {
  const definitions = await prisma.labelDefinition.findMany({
    select: { key: true },
    orderBy: { key: 'asc' },
  })
  return definitions.map((definition) => definition.key)
}

/**
 * Lists accounts for the account list page, optionally filtered to accounts
 * carrying at least one of the given labels, sorted and paginated.
 * @param prisma - the Prisma client to query
 * @param filters - the label filter, sort, and pagination parameters
 * @returns the matching accounts for the requested page, plus the total match count
 */
export async function listAccounts(
  prisma: PrismaClient,
  filters: AccountListFilters,
): Promise<AccountListResult> {
  let accountIdFilter: string[] | undefined
  if (filters.labelKeys && filters.labelKeys.length > 0) {
    accountIdFilter = await findAccountIdsWithAnyLabel(prisma, filters.labelKeys)
    if (accountIdFilter.length === 0) {
      return { items: [], totalCount: 0 }
    }
  }

  const where = accountIdFilter ? { id: { in: accountIdFilter } } : {}

  const [rows, totalCount] = await Promise.all([
    prisma.account.findMany({
      where,
      orderBy: { [filters.sortBy]: filters.sortDirection },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.account.count({ where }),
  ])

  const activeLabelsByAccount = await getActiveLabelKeysByAccount(
    prisma,
    rows.map((row) => row.id),
  )

  return {
    items: rows.map((row) => ({
      id: row.id,
      screenName: row.screenName,
      displayName: row.displayName,
      followersCount: row.followersCount,
      tweetCount: row.tweetCount,
      lastCrawledAt: row.lastCrawledAt,
      isBlueVerified: row.isBlueVerified,
      activeLabelKeys: activeLabelsByAccount.get(row.id) ?? [],
    })),
    totalCount,
  }
}
