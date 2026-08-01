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
 * 集計クエリ `latest_labels` をまとめて実行する: ラベル付けずみアカウント数と
 * ラベルごとの分布を、`AccountLabelLatest` を1回だけ読んでダッシュボードの
 * ページロードのたびに同じ集計を二重に実行しないようにする (テーブルの設計
 * 意図は prisma/schema.prisma の AccountLabelLatest コメントを参照)。
 * `latest_labels` は `NOT MATERIALIZED` を指定し、`value = true` の絞り込みを
 * `label_counts`/最上位 SELECT 側からプランナーが押し下げられるようにしている。
 * `MATERIALIZED` を指定すると常に Seq Scan + 一時領域への実体化が強制され、
 * `AccountLabelLatest_value_accountId_idx` を使った index-only scan が選ばれず
 * 数倍遅くなる。無関係なディスク I/O 競合でクエリが詰まった場合に備え、念のため
 * statement_timeout も設定し、コネクションプールの枠を握ったままにしない。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル付けずみアカウント数とラベル分布
 */
async function queryLatestLabelsSummary(prisma: PrismaClient): Promise<LatestLabelsSummary> {
  const result = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL statement_timeout = '15000'`,
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

  // トップレベルの SELECT に FROM 句がなく常に1行だけ返るが、Prisma の
  // $queryRaw の戻り値の型は配列であり要素数を型では保証できないため、
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
 * 集計済みの latest_labels summary を返す。実行中または直近に解決した
 * promise があればそれを再利用する。解決済みの値だけでなく実行中の promise
 * 自体をキャッシュすることで、getDashboardKpis と getLabelDistribution を
 * ダッシュボードページから Promise.all で同時に呼んだ場合でも、実際のクエリは
 * 1回にまとめられる。以後 CACHE_TTL_MS の間は同じ結果を返し続ける。失敗した
 * クエリはキャッシュしないため、次回呼び出し時は TTL 内であっても DB へ
 * 再試行する(同じエラーを TTL 満了まで返し続けることはない)。
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
 * ダッシュボードの上部に表示する KPI を読み込む: 累計アカウント数・ツイート数、
 * 現在少なくとも1つのラベルが true になっているアカウント数 (各ラベルの
 * 最新評価のみを使う点は {@link getLabelDistribution} と同じ)、全アカウント中
 * 最新のクロール日時。
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
 * ダッシュボードに表示するラベルごとの分布を読み込む: 各 `LabelDefinition`
 * について、これまでに評価されたアカウント数のうち現在の最新評価が `true`
 * であるアカウント数を返す。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル定義ごとの分布 (ラベルキー順)
 */
export async function getLabelDistribution(
  prisma: PrismaClient,
): Promise<LabelDistributionEntry[]> {
  const summary = await getLatestLabelsSummary(prisma)
  return summary.distribution
}
