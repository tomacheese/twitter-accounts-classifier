import type { PrismaClient, WeeklyAnalysisRun } from '../../generated/prisma'

/**
 * A summarized `WeeklyAnalysisRun` row for display, with the sampled account
 * count derived from the raw JSON array.
 */
export interface WeeklyRunSummary {
  id: string
  startedAt: Date
  finishedAt: Date | null
  commitSha: string | null
  sampledAccountCount: number
  findings: string | null
}

function toSummary(run: WeeklyAnalysisRun): WeeklyRunSummary {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    commitSha: run.commitSha,
    sampledAccountCount: Array.isArray(run.sampledAccountIds) ? run.sampledAccountIds.length : 0,
    findings: run.findings,
  }
}

/**
 * Loads the most recent weekly analysis runs, for the dashboard's summary section.
 * @param prisma - the Prisma client to query
 * @param limit - the maximum number of runs to return
 * @returns up to `limit` runs, most recent first
 */
export async function getRecentWeeklyRuns(
  prisma: PrismaClient,
  limit: number,
): Promise<WeeklyRunSummary[]> {
  const runs = await prisma.weeklyAnalysisRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
  })
  return runs.map((run) => toSummary(run))
}

/**
 * Loads the full weekly analysis run history, for the dedicated history page.
 * @param prisma - the Prisma client to query
 * @returns every run, most recent first
 */
export async function getAllWeeklyRuns(prisma: PrismaClient): Promise<WeeklyRunSummary[]> {
  const runs = await prisma.weeklyAnalysisRun.findMany({
    orderBy: { startedAt: 'desc' },
  })
  return runs.map((run) => toSummary(run))
}
