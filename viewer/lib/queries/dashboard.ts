import { cache } from 'react'
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

export type LabelAggregateAttemptStatus = 'success' | 'failed'

export interface LabelAggregateSnapshot {
  labeledAccounts: number
  distribution: LabelDistributionEntry[]
  lastSuccessAt: Date | null
  lastAttemptStatus: LabelAggregateAttemptStatus | null
}

const STATUS_ID = 'global'

/**
 * crawler/db/label-aggregate-repository.ts が書き込む文字列は TypeScript の
 * 型では強制できないため、想定外の値は成功扱いにせず null (未集計扱い) へ
 * fail closed させる。
 * @param value - LabelAggregateStatus.lastAttemptStatus の生値
 * @returns 既知の状態値、または null
 */
function toAttemptStatus(value: string | undefined): LabelAggregateAttemptStatus | null {
  return value === 'success' || value === 'failed' ? value : null
}

/**
 * LabelAggregate と LabelAggregateStatus は crawler が書き込む事前計算済みテーブルであるため、
 * 主キー・固定 ID で読むだけで済ませ、AccountLabelLatest への Seq Scan を避けている。
 * 2つのテーブルを同一トランザクション内の RepeatableRead で読むのは、
 * crawler 側の upsert 途中の中間状態を読んでラベル分布と labeledAccounts の値が
 * ずれるのを防ぐため。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns ラベル付けずみアカウント数、ラベル分布、直近の集計成否
 */
export const getLabelAggregateSnapshot = cache(async function getLabelAggregateSnapshot(
  prisma: PrismaClient,
): Promise<LabelAggregateSnapshot> {
  const [rows, status] = await prisma.$transaction(
    async (tx) =>
      Promise.all([
        tx.labelAggregate.findMany(),
        tx.labelAggregateStatus.findUnique({ where: { id: STATUS_ID } }),
      ]),
    { isolationLevel: 'RepeatableRead' },
  )

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
    lastAttemptStatus: toAttemptStatus(status?.lastAttemptStatus),
  }
})

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
