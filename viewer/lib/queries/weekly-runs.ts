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
  status: string
  currentPhase: string | null
  errorMessage: string | null
  pullRequestNumber: number | null
  pullRequestUrl: string | null
}

function toSummary(run: WeeklyAnalysisRun): WeeklyRunSummary {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    commitSha: run.commitSha,
    sampledAccountCount: Array.isArray(run.sampledAccountIds) ? run.sampledAccountIds.length : 0,
    findings: run.findings,
    status: run.status,
    currentPhase: run.currentPhase,
    errorMessage: run.errorMessage,
    pullRequestNumber: run.pullRequestNumber,
    pullRequestUrl: run.pullRequestUrl,
  }
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
