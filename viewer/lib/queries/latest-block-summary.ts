import type { PrismaClient } from '../../generated/prisma'

/** ダッシュボードの直近ブロック要約セクション向けの集計結果。 */
export interface LatestBlockSummary {
  blockRunId: string
  startedAt: Date
  finishedAt: Date | null
  status: string
  accountRunCount: number
  blockedCount: number
  failureCount: number
}

/**
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns 直近の BlockRun の要約。BlockRun が一件も存在しなければ `null`
 */
export async function getLatestBlockSummary(
  prisma: PrismaClient,
): Promise<LatestBlockSummary | null> {
  const latestRun = await prisma.blockRun.findFirst({
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    include: { _count: { select: { accountRuns: true } } },
  })
  if (!latestRun) return null

  const aggregate = await prisma.blockAccountRun.aggregate({
    where: { blockRunId: latestRun.id },
    _sum: { blockedCount: true, failedCount: true },
  })

  return {
    blockRunId: latestRun.id,
    startedAt: latestRun.startedAt,
    finishedAt: latestRun.finishedAt,
    status: latestRun.status,
    accountRunCount: latestRun._count.accountRuns,
    blockedCount: aggregate._sum.blockedCount ?? 0,
    failureCount: aggregate._sum.failedCount ?? 0,
  }
}
