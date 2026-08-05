import type { PrismaClient } from '../../generated/prisma'

/** ダッシュボードの直近クロール要約セクション向けの集計結果。 */
export interface LatestCrawlSummary {
  crawlRunId: string
  startedAt: Date
  finishedAt: Date | null
  status: string
  accountCount: number
  successCount: number
  partialOrFailedCount: number
}

/**
 * 再開を挟んだ CrawlRun では同一ユーザー名の CrawlAccountRun が複数行残りうるため、
 * ユーザー名ごとに最新の試行のみを集計対象にして二重カウントを避ける。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns 直近の CrawlRun の要約。CrawlRun が一件も存在しなければ `null`
 */
export async function getLatestCrawlSummary(
  prisma: PrismaClient,
): Promise<LatestCrawlSummary | null> {
  const latestRun = await prisma.crawlRun.findFirst({
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  })
  if (!latestRun) return null

  const accountRuns = await prisma.$queryRaw<{ username: string; status: string }[]>`
    SELECT DISTINCT ON ("username") "username", "status"
    FROM "CrawlAccountRun"
    WHERE "crawlRunId" = ${latestRun.id}
    ORDER BY "username", "startedAt" DESC, "id" DESC
  `

  const successCount = accountRuns.filter((run) => run.status === 'success').length

  return {
    crawlRunId: latestRun.id,
    startedAt: latestRun.startedAt,
    finishedAt: latestRun.finishedAt,
    status: latestRun.status,
    accountCount: accountRuns.length,
    successCount,
    partialOrFailedCount: accountRuns.length - successCount,
  }
}
