import type { PrismaClient } from '../../generated/prisma'
import { getReadModelReadiness } from '../read-model-meta'
import { listLabelSummaries } from './label-summary'

export interface DashboardKpis {
  totalAccounts: number
  totalTweets: number
  labeledAccounts: number | null
  lastCrawledAt: Date | null
}

export interface LabelDistributionEntry {
  labelKey: string
  labelDescription: string
  trueCount: number
  totalAccounts: number
}

const LABELED_ACCOUNT_COUNTER_ID = 'global'

/**
 * `AccountSummaryLatest` の bootstrap 未完了時は `LabeledAccountCounter` も母集団全体を反映しない。
 * そのため `accounts` read model が `ready` の場合のみ正常値として扱い、
 * それ以外は未確定であることを示す `null` を返す。
 * (0 だと「本当に0件」と「未集計」を型で区別できないため)
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns 少なくとも1つ true ラベルを持つ distinct account 数、未確定なら null
 */
async function getLabeledAccountsCount(prisma: PrismaClient): Promise<number | null> {
  const readiness = await getReadModelReadiness(prisma)
  if (readiness.accounts !== 'ready') return null
  const counter = await prisma.labeledAccountCounter.findUnique({
    where: { id: LABELED_ACCOUNT_COUNTER_ID },
  })
  return counter?.labeledAccounts ?? 0
}

/**
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ダッシュボードの KPI
 */
export async function getDashboardKpis(prisma: PrismaClient): Promise<DashboardKpis> {
  const [totalAccounts, totalTweets, labeledAccounts, lastCrawled] = await Promise.all([
    prisma.account.count(),
    prisma.tweet.count(),
    getLabeledAccountsCount(prisma),
    prisma.account.aggregate({ _max: { lastCrawledAt: true } }),
  ])

  return {
    totalAccounts,
    totalTweets,
    labeledAccounts,
    lastCrawledAt: lastCrawled._max.lastCrawledAt,
  }
}

/**
 * `label_summary` read model が `ready` でない間は空配列を返す
 * (bootstrap 未完了の部分値を確定値として表示しないため)。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル定義ごとの分布 (ラベルキー順)
 */
export async function getLabelDistribution(
  prisma: PrismaClient,
): Promise<LabelDistributionEntry[]> {
  const { items } = await listLabelSummaries(prisma)
  return items
    .map((item) => ({
      labelKey: item.labelKey,
      labelDescription: item.labelDescription,
      trueCount: item.trueCount,
      totalAccounts: item.evaluatedCount,
    }))
    .toSorted((a, b) => a.labelKey.localeCompare(b.labelKey))
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
  return distribution.toSorted((a, b) => b.trueCount - a.trueCount).slice(0, limit)
}
