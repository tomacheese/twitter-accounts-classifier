import type { PrismaClient } from '../../generated/prisma'

/** phase 別 duration 1 件。 */
export interface CrawlPhaseDurationView {
  phase: string
  durationMs: number | null
  retryWaitMs: number | null
}

/** Crawl 詳細の account 単位テーブル 1 行。 */
export interface CrawlAccountRunView {
  id: string
  username: string
  recommendedCount: number
  followingCount: number
  trendingCount: number
  replyCount: number
  profileCount: number
  labelsAppliedCount: number
  followingSynced: boolean
  followersSynced: boolean
  blocksSynced: boolean
  warningCounts: Record<string, number>
  phaseDurations: CrawlPhaseDurationView[]
  startedAt: Date
  finishedAt: Date | null
  status: string
}

/**
 * @param warnings - CrawlAccountRun.warnings (Json 配列)
 * @returns type ごとの件数
 */
function countWarningsByType(warnings: unknown): Record<string, number> {
  if (!Array.isArray(warnings)) return {}
  const counts: Record<string, number> = {}
  for (const warning of warnings) {
    if (typeof warning !== 'object' || warning === null) continue
    const type = (warning as Record<string, unknown>).type
    if (typeof type !== 'string') continue
    counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}

/**
 * @param prisma - Prisma クライアント
 * @param crawlRunId - 対象 CrawlRun の ID
 * @returns account 単位の counts・sync 状態・warning 集計・phase 別 duration
 */
export async function getCrawlAccountRuns(
  prisma: PrismaClient,
  crawlRunId: string,
): Promise<CrawlAccountRunView[]> {
  const accountRuns = await prisma.crawlAccountRun.findMany({
    where: { crawlRunId },
    orderBy: [{ startedAt: 'asc' }],
  })
  const usernames = accountRuns.map((run) => run.username)
  const checkpoints = await prisma.crawlAccountCheckpoint.findMany({
    where: { crawlRunId, username: { in: usernames } },
    orderBy: [{ completedAt: 'asc' }],
  })

  const phaseDurationsByUsername = new Map<string, CrawlPhaseDurationView[]>()
  for (const checkpoint of checkpoints) {
    const data = checkpoint.data as { durationMs?: number; retryWaitMs?: number } | null
    const list = phaseDurationsByUsername.get(checkpoint.username) ?? []
    list.push({
      phase: checkpoint.phase,
      durationMs: data?.durationMs ?? null,
      retryWaitMs: data?.retryWaitMs ?? null,
    })
    phaseDurationsByUsername.set(checkpoint.username, list)
  }

  return accountRuns.map((run) => ({
    id: run.id,
    username: run.username,
    recommendedCount: run.recommendedCount,
    followingCount: run.followingCount,
    trendingCount: run.trendingCount,
    replyCount: run.replyCount,
    profileCount: run.profileCount,
    labelsAppliedCount: run.labelsAppliedCount,
    followingSynced: run.followingSynced,
    followersSynced: run.followersSynced,
    blocksSynced: run.blocksSynced,
    warningCounts: countWarningsByType(run.warnings),
    phaseDurations: phaseDurationsByUsername.get(run.username) ?? [],
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
  }))
}
