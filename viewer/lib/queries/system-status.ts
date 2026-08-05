import type { PrismaClient } from '../../generated/prisma'
import { deriveHealthStatus, type HealthStatus } from '../health-status'

export type SystemStatusService = 'crawler' | 'blocker' | 'weekly_analysis'

/** ダッシュボードのシステム状況セクション向けに要約した、1サービス分の直近状況。 */
export interface SystemStatusEntry {
  service: SystemStatusService
  healthStatus: HealthStatus
  rawStatus: string | null
  startedAt: Date | null
  finishedAt: Date | null
  lastSuccessAt: Date | null
  lastDurationMs: number | null
  errorMessage: string | null
  detailHref: string
}

interface LatestRunLike {
  status: string
  startedAt: Date
  finishedAt: Date | null
  staleAfterAt: Date | null
  errorMessage?: string | null
}

interface SuccessRunLike {
  startedAt: Date
  finishedAt: Date | null
}

function toDurationMs(run: SuccessRunLike | null): number | null {
  if (!run?.finishedAt) return null
  return run.finishedAt.getTime() - run.startedAt.getTime()
}

function toEntry(
  service: SystemStatusService,
  latest: LatestRunLike | null,
  lastSuccess: SuccessRunLike | null,
  detailHref: string,
  now: Date,
): SystemStatusEntry {
  return {
    service,
    healthStatus: deriveHealthStatus(
      latest ? { status: latest.status, staleAfterAt: latest.staleAfterAt } : null,
      now,
    ),
    rawStatus: latest?.status ?? null,
    startedAt: latest?.startedAt ?? null,
    finishedAt: latest?.finishedAt ?? null,
    lastSuccessAt: lastSuccess?.finishedAt ?? null,
    lastDurationMs: toDurationMs(lastSuccess),
    errorMessage: latest?.errorMessage ?? null,
    detailHref,
  }
}

/**
 * @param prisma - クエリを実行する Prisma クライアント
 * @param now - health status 判定に使う基準時刻
 * @returns Crawler・Blocker・週次分析の順で並んだシステム状況一覧
 */
export async function getSystemStatus(
  prisma: PrismaClient,
  now: Date,
): Promise<SystemStatusEntry[]> {
  const orderBy = [{ startedAt: 'desc' as const }, { id: 'desc' as const }]

  const [
    latestCrawlRun,
    lastSuccessfulCrawlRun,
    latestBlockRun,
    lastSuccessfulBlockRun,
    latestWeeklyAnalysisRun,
    lastSuccessfulWeeklyAnalysisRun,
  ] = await Promise.all([
    prisma.crawlRun.findFirst({ orderBy }),
    prisma.crawlRun.findFirst({ where: { status: 'success' }, orderBy }),
    prisma.blockRun.findFirst({ orderBy }),
    prisma.blockRun.findFirst({ where: { status: 'completed' }, orderBy }),
    prisma.weeklyAnalysisRun.findFirst({ orderBy }),
    prisma.weeklyAnalysisRun.findFirst({ where: { status: 'success' }, orderBy }),
  ])

  return [
    toEntry('crawler', latestCrawlRun, lastSuccessfulCrawlRun, '/crawl-runs', now),
    toEntry('blocker', latestBlockRun, lastSuccessfulBlockRun, '/block-runs', now),
    toEntry(
      'weekly_analysis',
      latestWeeklyAnalysisRun,
      lastSuccessfulWeeklyAnalysisRun,
      '/weekly-runs',
      now,
    ),
  ]
}
