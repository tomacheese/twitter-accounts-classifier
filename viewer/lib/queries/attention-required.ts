import type { PrismaClient } from '../../generated/prisma'
import type { SystemStatusService } from './system-status'

export type AttentionItemKind = 'stale_run' | 'failed_run' | 'account_warning' | 'block_failure'

/** ダッシュボードの対応が必要な項目セクション向けの1行分。 */
export interface AttentionItem {
  kind: AttentionItemKind
  service: SystemStatusService
  message: string
  occurredAt: Date
  href: string
}

/**
 * 直近 20 件までに絞るのは、ダッシュボードの一覧として意味を持つのはごく直近の異常であり、
 * 古い異常まで遡って表示すると本当に見るべき異常が埋もれるため。
 */
const RECENT_LIMIT = 20

interface StaleCandidateRun {
  id: string
  staleAfterAt: Date | null
}

interface FailedRun {
  id: string
  finishedAt: Date | null
  startedAt: Date
}

interface TerminalWeeklyAnalysisRun {
  id: string
  status: string
  finishedAt: Date | null
  startedAt: Date
  errorMessage: string | null
}

interface CrawlAccountWarning {
  crawlRunId: string
  username: string
  status: string
  startedAt: Date
}

interface BlockAccountFailure {
  blockRunId: string
  username: string
  errorMessage: string | null
  startedAt: Date
}

function toStaleItems(
  runs: StaleCandidateRun[],
  service: SystemStatusService,
  label: string,
  toHref: (id: string) => string,
  now: Date,
): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const run of runs) {
    if (run.staleAfterAt && run.staleAfterAt.getTime() < now.getTime()) {
      items.push({
        kind: 'stale_run',
        service,
        message: `${label} run ${run.id} has not sent a heartbeat since its stale deadline.`,
        occurredAt: run.staleAfterAt,
        href: toHref(run.id),
      })
    }
  }
  return items
}

function toFailedRunItems(
  runs: FailedRun[],
  service: SystemStatusService,
  hrefPrefix: string,
  label: string,
): AttentionItem[] {
  return runs.map((run) => ({
    kind: 'failed_run',
    service,
    message: `${label} run ${run.id} failed.`,
    occurredAt: run.finishedAt ?? run.startedAt,
    href: `${hrefPrefix}/${run.id}`,
  }))
}

/**
 * @param prisma - クエリを実行する Prisma クライアント
 * @param now - 停止放置判定に使う基準時刻
 * @returns 対応が必要な項目一覧 (新しい順)
 */
export async function getAttentionRequiredItems(
  prisma: PrismaClient,
  now: Date,
): Promise<AttentionItem[]> {
  const [
    runningCrawlRuns,
    failedCrawlRuns,
    runningBlockRuns,
    failedBlockRuns,
    runningWeeklyAnalysisRuns,
    terminalWeeklyAnalysisRuns,
    warnedCrawlAccountRuns,
    failedBlockAccountRuns,
  ] = await Promise.all([
    prisma.crawlRun.findMany({
      where: { status: 'running' },
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
    }),
    prisma.crawlRun.findMany({
      where: { status: 'failed' },
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
    }),
    prisma.blockRun.findMany({
      where: { status: 'running' },
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
    }),
    prisma.blockRun.findMany({
      where: { status: 'failed' },
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
    }),
    prisma.weeklyAnalysisRun.findMany({
      where: { status: 'running' },
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
    }),
    prisma.weeklyAnalysisRun.findMany({
      where: { status: { in: ['failed', 'timeout'] } },
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
    }),
    prisma.crawlAccountRun.findMany({
      where: { status: { in: ['partial', 'failed'] } },
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
    }),
    prisma.blockAccountRun.findMany({
      where: { errorMessage: { not: null } },
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
    }),
  ])

  const items: AttentionItem[] = [
    ...toStaleItems(
      runningCrawlRuns as StaleCandidateRun[],
      'crawler',
      'Crawl',
      (id) => `/crawl-runs/${id}`,
      now,
    ),
    ...toFailedRunItems(failedCrawlRuns as FailedRun[], 'crawler', '/crawl-runs', 'Crawl'),
    ...toStaleItems(
      runningBlockRuns as StaleCandidateRun[],
      'blocker',
      'Block',
      (id) => `/block-runs/${id}`,
      now,
    ),
    ...toFailedRunItems(failedBlockRuns as FailedRun[], 'blocker', '/block-runs', 'Block'),
    ...toStaleItems(
      runningWeeklyAnalysisRuns as StaleCandidateRun[],
      'weekly_analysis',
      'Weekly analysis',
      () => '/weekly-runs',
      now,
    ),
  ]

  for (const run of terminalWeeklyAnalysisRuns as TerminalWeeklyAnalysisRun[]) {
    items.push({
      kind: 'failed_run',
      service: 'weekly_analysis',
      message: run.errorMessage ?? `Weekly analysis run ${run.id} ended with status ${run.status}.`,
      occurredAt: run.finishedAt ?? run.startedAt,
      href: '/weekly-runs',
    })
  }

  for (const accountRun of warnedCrawlAccountRuns as CrawlAccountWarning[]) {
    items.push({
      kind: 'account_warning',
      service: 'crawler',
      message: `Account ${accountRun.username} ended with status ${accountRun.status}.`,
      occurredAt: accountRun.startedAt,
      href: `/crawl-runs/${accountRun.crawlRunId}`,
    })
  }

  for (const accountRun of failedBlockAccountRuns as BlockAccountFailure[]) {
    items.push({
      kind: 'block_failure',
      service: 'blocker',
      message: accountRun.errorMessage ?? `Account ${accountRun.username} had a block failure.`,
      occurredAt: accountRun.startedAt,
      href: `/block-runs/${accountRun.blockRunId}`,
    })
  }

  return items.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
}
