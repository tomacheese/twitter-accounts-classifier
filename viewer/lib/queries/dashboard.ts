import type { PrismaClient } from '../../generated/prisma'
import { captureException } from '../monitoring/sentry'

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
 * 60秒への引き上げは、テーブル増大によりクエリ所要時間が旧設定の15秒を上回るようになったための対応であり、
 * プール枠の占有時間が延びるトレードオフは、下記のバックグラウンド更新でコールドクエリの発生頻度自体を減らすことで許容している。
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
 * TTL の有無にかかわらず必ず DB へ問い合わせ、その結果でキャッシュを上書きする。
 * バックグラウンドでの定期更新は、まだ有効なキャッシュを使い回されると更新にならないため、
 * getLatestLabelsSummary の TTL チェックを経由しないこの関数を直接呼ぶ必要がある。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル付けずみアカウント数とラベル分布
 */
function refreshLatestLabelsSummary(prisma: PrismaClient): Promise<LatestLabelsSummary> {
  const promise = queryLatestLabelsSummary(prisma)
  const entry = { promise, expiresAt: Date.now() + CACHE_TTL_MS }
  cached = entry
  promise.catch(() => {
    if (cached === entry) {
      cached = undefined
    }
  })

  return promise
}

/**
 * 解決済みの値だけでなく実行中の promise 自体もキャッシュすることで、
 * getDashboardKpis と getLabelDistribution を Promise.all で同時に呼んでも、
 * 実際のクエリは1回にまとめられる。
 * 更新中のキャッシュを使い回す(stale-while-revalidate)実装にはしていない。
 * 更新の頻度自体をバックグラウンドの定期更新で抑えているため、
 * 更新中の待ち時間は許容できると判断している。
 * 失敗したクエリはキャッシュしないため、次回呼び出し時は TTL 内であっても DB へ再試行する。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル付けずみアカウント数とラベル分布
 */
function getLatestLabelsSummary(prisma: PrismaClient): Promise<LatestLabelsSummary> {
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return cached.promise
  }

  return refreshLatestLabelsSummary(prisma)
}

/** キャッシュの TTL 切れの何ミリ秒前にバックグラウンド更新を行うか。1分。 */
const WARM_BEFORE_EXPIRY_MS = 60 * 1000

let warmingStarted = false

/**
 * @param prisma - クエリを実行する Prisma クライアント
 */
function warmLatestLabelsSummary(prisma: PrismaClient): void {
  refreshLatestLabelsSummary(prisma).catch((error: unknown) => {
    console.error('Failed to warm dashboard label summary cache:', error)
    captureException(error, { source: 'startLatestLabelsSummaryWarming' })
  })
}

/**
 * setInterval だけでは、起動直後の1周期分と、TTL 切れの直前1分間だけキャッシュが有効なままの周期とで、
 * ユーザーのアクセスがコールドキャッシュの重いクエリを踏む隙間が残る。
 * このため起動直後に即時実行し、以降は TTL チェックを経由しない強制更新を周期実行する。
 * @param prisma - クエリを実行する Prisma クライアント
 */
export function startLatestLabelsSummaryWarming(prisma: PrismaClient): void {
  if (warmingStarted) return
  warmingStarted = true

  warmLatestLabelsSummary(prisma)
  const timer = setInterval(() => {
    warmLatestLabelsSummary(prisma)
  }, CACHE_TTL_MS - WARM_BEFORE_EXPIRY_MS)
  timer.unref()
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

/**
 * @param prisma - クエリを実行する Prisma クライアント
 * @param limit - 取得する件数の上限
 * @returns 陽性件数の多い順で最大 limit 件のラベル分布
 */
export async function getTopLabelOverview(
  prisma: PrismaClient,
  limit: number,
): Promise<LabelDistributionEntry[]> {
  const distribution = await getLabelDistribution(prisma)
  return [...distribution].sort((a, b) => b.trueCount - a.trueCount).slice(0, limit)
}
