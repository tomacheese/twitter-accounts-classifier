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

export interface LabelAggregateSnapshot {
  labeledAccounts: number
  distribution: LabelDistributionEntry[]
  lastSuccessAt: Date | null
  lastAttemptStatus: string | null
}

const STATUS_ID = 'global'

/**
 * LabelAggregate/LabelAggregateStatus は crawler がラベリング完了時に書き込む
 * 事前計算済みテーブルのため、ここでは主キー・固定IDで読むだけで
 * AccountLabelLatest には一切触れない。
 * LabelAggregateStatus がまだ1行も書き込まれていない場合は、
 * 集計が一度も成功していない初期状態としてゼロ値を返す。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル付けずみアカウント数、ラベル分布、直近の集計成否
 */
export async function getLabelAggregateSnapshot(
  prisma: PrismaClient,
): Promise<LabelAggregateSnapshot> {
  const [rows, status] = await Promise.all([
    prisma.labelAggregate.findMany(),
    prisma.labelAggregateStatus.findUnique({ where: { id: STATUS_ID } }),
  ])

  return {
    labeledAccounts: status?.labeledAccounts ?? 0,
    distribution: rows
      .map((row) => ({
        labelKey: row.labelKey,
        labelDescription: row.labelDescription,
        trueCount: row.trueCount,
        totalAccounts: row.totalCount,
      }))
      .toSorted((a, b) => a.labelKey.localeCompare(b.labelKey)),
    lastSuccessAt: status?.lastSuccessAt ?? null,
    lastAttemptStatus: status?.lastAttemptStatus ?? null,
  }
}

/**
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ダッシュボードの KPI
 */
export async function getDashboardKpis(prisma: PrismaClient): Promise<DashboardKpis> {
  const [totalAccounts, totalTweets, snapshot, lastCrawled] = await Promise.all([
    prisma.account.count(),
    prisma.tweet.count(),
    getLabelAggregateSnapshot(prisma),
    prisma.account.aggregate({ _max: { lastCrawledAt: true } }),
  ])

  return {
    totalAccounts,
    totalTweets,
    labeledAccounts: snapshot.labeledAccounts,
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
  const snapshot = await getLabelAggregateSnapshot(prisma)
  return snapshot.distribution
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
