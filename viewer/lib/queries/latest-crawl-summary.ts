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
      AND "classificationStatus" <> 'skipped'
    ORDER BY "username", "startedAt" DESC, "id" DESC
  `

  const successCount = accountRuns.filter((run) => run.status === 'success').length
  const appVersions = [...new Set(accountRuns.map((run) => run.appVersion))].toSorted()

  let recommendedCount = 0
  let followingCount = 0
  let trendingCount = 0
  let replyCount = 0
  let profileCount = 0
  let labelsAppliedCount = 0
  let warningCount = 0
  let totalDurationMs = 0
  for (const run of accountRuns) {
    recommendedCount += run.recommendedCount
    followingCount += run.followingCount
    trendingCount += run.trendingCount
    replyCount += run.replyCount
    profileCount += run.profileCount
    labelsAppliedCount += run.labelsAppliedCount
    warningCount += run.warnings.length
    if (run.finishedAt) {
      totalDurationMs += run.finishedAt.getTime() - run.startedAt.getTime()
    }
  }

  return {
    crawlRunId: latestRun.id,
    startedAt: latestRun.startedAt,
    finishedAt: latestRun.finishedAt,
    status: latestRun.status,
    accountCount: accountRuns.length,
    successCount,
    partialOrFailedCount: accountRuns.length - successCount,
    recommendedCount,
    followingCount,
    trendingCount,
    replyCount,
    profileCount,
    labelsAppliedCount,
    warningCount,
    totalDurationMs,
    appVersions,
  }
}
