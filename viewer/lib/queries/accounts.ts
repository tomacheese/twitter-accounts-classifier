import { Prisma, type PrismaClient } from '../../generated/prisma'

export type AccountSortField = 'followersCount' | 'tweetCount' | 'lastCrawledAt'
export type SortDirection = 'asc' | 'desc'

/**
 * {@link listAccounts} に渡すラベルフィルタ・ソート・ページネーションの条件。
 */
export interface AccountListFilters {
  labelKeys?: string[]
  page: number
  pageSize: number
  sortBy: AccountSortField
  sortDirection: SortDirection
}

/**
 * アカウント一覧ページに表示する1行分のアカウント情報。
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
 * ページネーション向けに、1ページ分のアカウント一覧と総件数をまとめたもの。
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
 * `AccountLabelLatest` を読む (設計意図は prisma/schema.prisma のコメントを参照)。
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
 * 指定した各アカウントについて、
 * 有効な (最新評価が `true` の) ラベルキーを読み込む。
 * アカウント一覧のラベルバッジ表示用。
 * `AccountLabelLatest` を読む点は {@link findAccountIdsWithAnyLabel} と同じ。
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
 * アカウント一覧ページのラベルフィルタ向けに、登録済みの全ラベルキーを読み込む。
 * {@link getLabelDistribution} (dashboard.ts) より意図的に軽量にしてあり、
 * フィルタにはキー一覧のみで十分で true/total の集計は不要なため、
 * `AccountLabelLatest` は読まず `LabelDefinition` のみを問い合わせる。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns アルファベット順に並べた全ラベルキー
 */
export async function getLabelKeys(prisma: PrismaClient): Promise<string[]> {
  const definitions = await prisma.labelDefinition.findMany({
    select: { key: true },
    orderBy: { key: 'asc' },
  })
  return definitions.map((definition) => definition.key)
}

/**
 * アカウント一覧ページ向けに、
 * 指定したラベルのいずれかを持つアカウントへ絞り込んだうえで、
 * ソート・ページネーションして返す。
 * @param prisma - クエリを実行する Prisma クライアント
 * @param filters - ラベルフィルタ・ソート・ページネーションの条件
 * @returns 該当ページのアカウント一覧と総件数
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
