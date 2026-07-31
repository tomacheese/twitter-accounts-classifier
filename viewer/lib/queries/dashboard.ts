import type { PrismaClient } from '../../generated/prisma'

/**
 * The top-level KPI figures shown on the dashboard.
 */
export interface DashboardKpis {
  totalAccounts: number
  totalTweets: number
  labeledAccounts: number
  lastCrawledAt: Date | null
}

/**
 * One label's distribution across all evaluated accounts.
 */
export interface LabelDistributionEntry {
  labelKey: string
  labelDescription: string
  trueCount: number
  totalAccounts: number
}

interface LabeledAccountCountRow {
  count: bigint
}

interface LabelDistributionRow {
  labelKey: string
  labelDescription: string
  trueCount: bigint
  totalAccounts: bigint
}

/**
 * Loads the top-level KPI figures shown on the dashboard: total accounts and
 * tweets accumulated, how many accounts currently carry at least one positive
 * label (using only each account's most recent evaluation per label, same
 * rule as {@link getLabelDistribution}), and the most recent crawl timestamp
 * across all accounts.
 * @param prisma - the Prisma client to query
 * @returns the dashboard KPI figures
 */
export async function getDashboardKpis(prisma: PrismaClient): Promise<DashboardKpis> {
  const [totalAccounts, totalTweets, [, labeledAccountRows], lastCrawled] = await Promise.all([
    prisma.account.count(),
    prisma.tweet.count(),
    prisma.$transaction([
      // The planner's cost model underestimates how cheap
      // "AccountLabel_accountId_labelDefinitionId_labeledAt_id_idx" is on this
      // table (it already returns rows in the exact order the CTE below sorts
      // by), so left to itself it picks a cheaper-looking plan that instead
      // sorts the whole table by hand. Disabling incremental sort for this
      // transaction only steers it onto the index scan, which is
      // measurably faster in practice - see the migration note for this index.
      prisma.$executeRaw`SET LOCAL enable_incremental_sort = off`,
      prisma.$queryRaw<LabeledAccountCountRow[]>`
        WITH latest_labels AS (
          SELECT DISTINCT ON ("accountId", "labelDefinitionId")
            "accountId", value
          FROM "AccountLabel"
          ORDER BY "accountId", "labelDefinitionId", "labeledAt" DESC, "id" DESC
        )
        SELECT COUNT(DISTINCT "accountId") AS count
        FROM latest_labels
        WHERE value = true
      `,
    ]),
    prisma.account.aggregate({ _max: { lastCrawledAt: true } }),
  ])

  return {
    totalAccounts,
    totalTweets,
    labeledAccounts: Number(labeledAccountRows[0]?.count ?? 0),
    lastCrawledAt: lastCrawled._max.lastCrawledAt,
  }
}

/**
 * Loads the per-label distribution shown on the dashboard: for every
 * `LabelDefinition`, how many accounts currently carry that label as `true`
 * (using only each account's most recent evaluation of that label) out of
 * how many accounts have ever been evaluated for it.
 * @param prisma - the Prisma client to query
 * @returns one entry per label definition, ordered by label key
 */
export async function getLabelDistribution(
  prisma: PrismaClient,
): Promise<LabelDistributionEntry[]> {
  const [, rows] = await prisma.$transaction([
    // See the matching comment in getDashboardKpis for why this is needed.
    prisma.$executeRaw`SET LOCAL enable_incremental_sort = off`,
    prisma.$queryRaw<LabelDistributionRow[]>`
      WITH latest_labels AS (
        SELECT DISTINCT ON ("accountId", "labelDefinitionId")
          "accountId", "labelDefinitionId", value
        FROM "AccountLabel"
        ORDER BY "accountId", "labelDefinitionId", "labeledAt" DESC, "id" DESC
      )
      SELECT
        ld.key AS "labelKey",
        ld.description AS "labelDescription",
        COALESCE(COUNT(*) FILTER (WHERE ll.value), 0) AS "trueCount",
        COALESCE(COUNT(ll."accountId"), 0) AS "totalAccounts"
      FROM "LabelDefinition" ld
      LEFT JOIN latest_labels ll ON ll."labelDefinitionId" = ld.id
      GROUP BY ld.id, ld.key, ld.description
      ORDER BY ld.key
    `,
  ])

  return rows.map((row: LabelDistributionRow) => ({
    labelKey: row.labelKey,
    labelDescription: row.labelDescription,
    trueCount: Number(row.trueCount),
    totalAccounts: Number(row.totalAccounts),
  }))
}
