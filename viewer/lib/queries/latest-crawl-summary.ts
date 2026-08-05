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
  recommendedCount: number
  followingCount: number
  trendingCount: number
  replyCount: number
  profileCount: number
  labelsAppliedCount: number
  warningCount: number
  totalDurationMs: number
  /** 実行途中の再デプロイをまたぐと複数バージョンが混在しうるため、配列で保持する。 */
  appVersions: string[]
}

interface LatestCrawlAccountRow {
  username: string
  status: string
  startedAt: Date
  finishedAt: Date | null
  recommendedCount: number
  followingCount: number
  trendingCount: number
  replyCount: number
  profileCount: number
  labelsAppliedCount: number
  warnings: unknown[]
  appVersion: string
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

  const accountRuns = await prisma.$queryRaw<LatestCrawlAccountRow[]>`
    SELECT DISTINCT ON ("username")
      "username", "status", "startedAt", "finishedAt",
      "recommendedCount", "followingCount", "trendingCount", "replyCount", "profileCount",
      "labelsAppliedCount", "warnings", "appVersion"
    FROM "CrawlAccountRun"
    WHERE "crawlRunId" = ${latestRun.id}
    ORDER BY "username", "startedAt" DESC, "id" DESC
  `

  const successCount = accountRuns.filter((run) => run.status === 'success').length
  const appVersions = [...new Set(accountRuns.map((run) => run.appVersion))].toSorted()

  return {
    crawlRunId: latestRun.id,
    startedAt: latestRun.startedAt,
    finishedAt: latestRun.finishedAt,
    status: latestRun.status,
    accountCount: accountRuns.length,
    successCount,
    partialOrFailedCount: accountRuns.length - successCount,
    recommendedCount: accountRuns.reduce((sum, run) => sum + run.recommendedCount, 0),
    followingCount: accountRuns.reduce((sum, run) => sum + run.followingCount, 0),
    trendingCount: accountRuns.reduce((sum, run) => sum + run.trendingCount, 0),
    replyCount: accountRuns.reduce((sum, run) => sum + run.replyCount, 0),
    profileCount: accountRuns.reduce((sum, run) => sum + run.profileCount, 0),
    labelsAppliedCount: accountRuns.reduce((sum, run) => sum + run.labelsAppliedCount, 0),
    warningCount: accountRuns.reduce((sum, run) => sum + run.warnings.length, 0),
    totalDurationMs: accountRuns.reduce((sum, run) => {
      if (!run.finishedAt) return sum
      return sum + (run.finishedAt.getTime() - run.startedAt.getTime())
    }, 0),
    appVersions,
  }
}
