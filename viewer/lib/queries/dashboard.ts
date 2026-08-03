import type { PrismaClient } from '../../generated/prisma'

export interface DashboardKpis {
  totalAccounts: number
  totalTweets: number
  labeledAccounts: number
  lastCrawledAt: Date | null
}

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
 * `latest_labels` を `NOT MATERIALIZED` にしているのは、
 * `MATERIALIZED` では Seq Scan と一時領域への実体化が強制され、
 * `AccountLabelLatest_value_accountId_idx` を使った index-only scan が選ばれなくなるため。
 * statement_timeout は、
 * クエリが詰まった場合にプールの枠を占有し続けて枯渇を招くのを防ぐために設定している
 * (`AccountLabelLatest` の設計意図は prisma/schema.prisma の該当コメントを参照)。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル付けずみアカウント数とラベル分布
 */
async function queryLatestLabelsSummary(prisma: PrismaClient): Promise<LatestLabelsSummary> {
  const result = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL statement_timeout = '60000'`,
    prisma.$queryRaw<LatestLabelsSummaryRow[]>`
      WITH latest_labels AS NOT MATERIALIZED (
        SELECT "accountId", "labelDefinitionId", "value"
        FROM "AccountLabelLatest"
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
        (SELECT COUNT(DISTINCT "accountId") FROM latest_labels WHERE "value" = true) AS "labeledAccounts",
        (
          SELECT COALESCE(json_agg(lc.* ORDER BY lc."labelKey"), '[]'::json)
          FROM label_counts lc
        ) AS distribution
    `,
  ])
  const rows = result[1]

  // トップレベルの SELECT に FROM 句がなく常に1行だけ返るが、
  // Prisma の $queryRaw の戻り値の型は配列であり要素数を型では保証できないため、
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
 * 解決済みの値だけでなく実行中の promise 自体もキャッシュすることで、
 * getDashboardKpis と getLabelDistribution を Promise.all で同時に呼んでも、
 * 実際のクエリは1回にまとめられる。
 * 失敗したクエリはキャッシュしないため、次回呼び出し時は TTL 内であっても DB へ再試行する。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル付けずみアカウント数とラベル分布
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
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ダッシュボードの KPI
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
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル定義ごとの分布 (ラベルキー順)
 */
export async function getLabelDistribution(
  prisma: PrismaClient,
): Promise<LabelDistributionEntry[]> {
  const summary = await getLatestLabelsSummary(prisma)
  return summary.distribution
}
