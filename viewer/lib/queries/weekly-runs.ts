import type { PrismaClient, WeeklyAnalysisRun } from '../../generated/prisma'

/**
 * 表示用に要約した `WeeklyAnalysisRun`。sampledAccountCount は生の JSON 配列から算出する。
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
 * ダッシュボードの概要向けに、直近の週次分析実行を読み込む。
 * @param prisma - クエリを実行する Prisma クライアント
 * @param limit - 取得する実行数の上限
 * @returns 新しい順で最大 limit 件の実行
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
 * 履歴ページ向けに、週次分析実行の全履歴を読み込む。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns 新しい順の全実行
 */
export async function getAllWeeklyRuns(prisma: PrismaClient): Promise<WeeklyRunSummary[]> {
  const runs = await prisma.weeklyAnalysisRun.findMany({
    orderBy: { startedAt: 'desc' },
  })
  return runs.map((run) => toSummary(run))
}
