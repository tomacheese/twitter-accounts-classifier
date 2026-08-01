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

// json_agg() が返す distribution の要素はすでに JSON としてパース済みのため、
// trueCount/totalAccounts はここでは(直接の bigint 列とは異なり)number で届く。
interface LabelDistributionJsonRow {
  labelKey: string
  labelDescription: string
  trueCount: number
  totalAccounts: number
}

interface LatestLabelsSummaryRow {
  labeledAccounts: bigint
  distribution: LabelDistributionJsonRow[]
}

interface LatestLabelsSummary {
  labeledAccounts: number
  distribution: LabelDistributionEntry[]
}

/**
 * Runs the merged `latest_labels` aggregation query: computes the
 * `DISTINCT ON` CTE once (materialized) and derives both the labeled-account
 * count and the per-label distribution from it in a single query, instead of
 * running the same expensive CTE twice per dashboard page view. Also sets a
 * statement_timeout so a query stuck behind disk I/O contention releases its
 * connection-pool slot instead of holding it for minutes.
 * @param prisma - the Prisma client to query
 * @returns the labeled account count and label distribution
 */
async function queryLatestLabelsSummary(prisma: PrismaClient): Promise<LatestLabelsSummary> {
  const result = await prisma.$transaction([
    // Cap how long this query may hold a pool connection: under disk I/O
    // contention (e.g. right after startup, while the crawler is seeding),
    // this query can otherwise run for minutes and starve the pool for
    // every other page. 15s is generous for the steady-state case but short
    // enough to fail fast and free the connection under contention.
    prisma.$executeRaw`SET LOCAL statement_timeout = '15000'`,
    // The planner's cost model underestimates how cheap
    // "AccountLabel_accountId_labelDefinitionId_labeledAt_id_idx" is on this
    // table (it already returns rows in the exact order the CTE below sorts
    // by), so left to itself it picks a cheaper-looking plan that instead
    // sorts the whole table by hand. Disabling incremental sort for this
    // transaction only steers it onto the index scan, which is
    // measurably faster in practice - see the migration note for this index.
    prisma.$executeRaw`SET LOCAL enable_incremental_sort = off`,
    prisma.$queryRaw<LatestLabelsSummaryRow[]>`
      WITH latest_labels AS MATERIALIZED (
        SELECT DISTINCT ON ("accountId", "labelDefinitionId")
          "accountId", "labelDefinitionId", value
        FROM "AccountLabel"
        ORDER BY "accountId", "labelDefinitionId", "labeledAt" DESC, "id" DESC
      ),
      label_counts AS (
        SELECT
          ld.key AS "labelKey",
          ld.description AS "labelDescription",
          COALESCE(COUNT(*) FILTER (WHERE ll.value), 0) AS "trueCount",
          COALESCE(COUNT(ll."accountId"), 0) AS "totalAccounts"
        FROM "LabelDefinition" ld
        LEFT JOIN latest_labels ll ON ll."labelDefinitionId" = ld.id
        GROUP BY ld.id, ld.key, ld.description
      )
      SELECT
        (SELECT COUNT(DISTINCT "accountId") FROM latest_labels WHERE value = true) AS "labeledAccounts",
        (
          SELECT COALESCE(json_agg(lc.* ORDER BY lc."labelKey"), '[]'::json)
          FROM label_counts lc
        ) AS distribution
    `,
  ])
  const rows = result[2]

  // rows は空配列で返ってくることがある(集計対象が0件など)ため、
  // Array#at() で undefined を許容する型のまま安全に取り出す。
  const row = rows.at(0)
  return {
    labeledAccounts: Number(row?.labeledAccounts ?? 0),
    distribution: (row?.distribution ?? []).map((entry) => ({
      labelKey: entry.labelKey,
      labelDescription: entry.labelDescription,
      trueCount: entry.trueCount,
      totalAccounts: entry.totalAccounts,
    })),
  }
}

/** latest_labels summary のキャッシュ有効期限(ミリ秒)。15分。 */
const CACHE_TTL_MS = 15 * 60 * 1000

let cached: { promise: Promise<LatestLabelsSummary>; expiresAt: number } | undefined

/**
 * Returns the merged latest_labels summary, reusing a cached in-flight or
 * recently-resolved promise when available. Caching the in-flight promise
 * itself (not just the resolved value) collapses concurrent callers - e.g.
 * getDashboardKpis and getLabelDistribution invoked together via
 * Promise.all on the dashboard page - onto a single underlying query, and
 * keeps serving the same result for CACHE_TTL_MS afterward. A failed query
 * is never cached, so the next call retries against the database instead of
 * re-throwing the same error for the rest of the TTL window.
 * @param prisma - the Prisma client to query
 * @returns the labeled account count and label distribution
 */
function getLatestLabelsSummary(prisma: PrismaClient): Promise<LatestLabelsSummary> {
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return cached.promise
  }

  const promise = queryLatestLabelsSummary(prisma)
  const entry = { promise, expiresAt: now + CACHE_TTL_MS }
  cached = entry
  promise.catch(() => {
    if (cached === entry) {
      cached = undefined
    }
  })

  return promise
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
  const [totalAccounts, totalTweets, summary, lastCrawled] = await Promise.all([
    prisma.account.count(),
    prisma.tweet.count(),
    getLatestLabelsSummary(prisma),
    prisma.account.aggregate({ _max: { lastCrawledAt: true } }),
  ])

  return {
    totalAccounts,
    totalTweets,
    labeledAccounts: summary.labeledAccounts,
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
  const summary = await getLatestLabelsSummary(prisma)
  return summary.distribution
}
