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
 * 再開を挟んだ BlockRun では同一ユーザー名の BlockAccountRun が複数行残りうるため、
 * ユーザー名ごとに最新の試行のみを集計対象にして二重カウントを避ける。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns 直近の BlockRun の要約。BlockRun が一件も存在しなければ `null`
 */
export async function getLatestBlockSummary(
  prisma: PrismaClient,
): Promise<LatestBlockSummary | null> {
  const latestRun = await prisma.blockRun.findFirst({
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  })
  if (!latestRun) return null

  const accountRuns = await prisma.$queryRaw<{ blockedCount: number; failedCount: number }[]>`
    SELECT DISTINCT ON ("username") "blockedCount", "failedCount"
    FROM "BlockAccountRun"
    WHERE "blockRunId" = ${latestRun.id}
    ORDER BY "username", "startedAt" DESC, "id" DESC
  `

  return {
    blockRunId: latestRun.id,
    startedAt: latestRun.startedAt,
    finishedAt: latestRun.finishedAt,
    status: latestRun.status,
    accountRunCount: accountRuns.length,
    blockedCount: accountRuns.reduce((sum, run) => sum + run.blockedCount, 0),
    failureCount: accountRuns.reduce((sum, run) => sum + run.failedCount, 0),
  }
}
