import type { PrismaClient } from '../../generated/prisma'
import type { SystemStatusService } from './system-status'

export type AttentionItemKind = 'stale_run' | 'failed_run' | 'account_warning' | 'block_failure'

/**
 * ダッシュボードの対応が必要な項目セクション向けの集計済み1行分。
 * 個別のエラー本文は詳細ページ側だけで表示する方針のため、ここでは件数と代表リンクのみ持つ。
 */
export interface AttentionItem {
  kind: AttentionItemKind
  service: SystemStatusService
  count: number
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
  finishedAt: Date | null
  startedAt: Date
}

interface CrawlAccountWarning {
  crawlRunId: string
  startedAt: Date
}

interface BlockAccountFailure {
  blockRunId: string
  startedAt: Date
}

const SERVICE_LABELS: Record<SystemStatusService, string> = {
  crawler: 'Crawl',
  blocker: 'Block',
  weekly_analysis: 'Weekly analysis',
}

/** 集計前の個別事象。件数集約の入力になるだけで、外部には公開しない。 */
interface RawOccurrence {
  kind: AttentionItemKind
  service: SystemStatusService
  occurredAt: Date
  href: string
}

function buildMessage(
  kind: AttentionItemKind,
  service: SystemStatusService,
  count: number,
): string {
  const label = SERVICE_LABELS[service]
  switch (kind) {
    case 'stale_run': {
      return `${count} ${label} run(s) have not sent a heartbeat since their stale deadline.`
    }
    case 'failed_run': {
      return `${count} ${label} run(s) failed.`
    }
    case 'account_warning': {
      return `${count} account(s) ended with a warning during the latest ${label} run.`
    }
    case 'block_failure': {
      return `${count} account(s) failed to block.`
    }
  }
}

/**
 * サービス・異常種別ごとに件数を集約する。
 * 詳細ページへのリンクは、その組み合わせの中で最も新しい事象のものを代表として使う。
 */
function summarize(occurrences: RawOccurrence[]): AttentionItem[] {
  const groups = new Map<
    string,
    {
      kind: AttentionItemKind
      service: SystemStatusService
      count: number
      latestOccurredAt: Date
      href: string
    }
  >()

  for (const occurrence of occurrences) {
    const key = `${occurrence.service}:${occurrence.kind}`
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        kind: occurrence.kind,
        service: occurrence.service,
        count: 1,
        latestOccurredAt: occurrence.occurredAt,
        href: occurrence.href,
      })
      continue
    }
    existing.count += 1
    if (occurrence.occurredAt.getTime() > existing.latestOccurredAt.getTime()) {
      existing.latestOccurredAt = occurrence.occurredAt
      existing.href = occurrence.href
    }
  }

  return [...groups.values()].map((group) => ({
    kind: group.kind,
    service: group.service,
    count: group.count,
    message: buildMessage(group.kind, group.service, group.count),
    occurredAt: group.latestOccurredAt,
    href: group.href,
  }))
}

function toStaleOccurrences(
  runs: StaleCandidateRun[],
  service: SystemStatusService,
  toHref: (id: string) => string,
  now: Date,
): RawOccurrence[] {
  const occurrences: RawOccurrence[] = []
  for (const run of runs) {
    if (run.staleAfterAt && run.staleAfterAt.getTime() < now.getTime()) {
      occurrences.push({
        kind: 'stale_run',
        service,
        occurredAt: run.staleAfterAt,
        href: toHref(run.id),
      })
    }
  }
  return occurrences
}

function toFailedRunOccurrences(
  runs: FailedRun[],
  service: SystemStatusService,
  toHref: (id: string) => string,
): RawOccurrence[] {
  return runs.map((run) => ({
    kind: 'failed_run',
    service,
    occurredAt: run.finishedAt ?? run.startedAt,
    href: toHref(run.id),
  }))
}

/**
 * @param prisma - クエリを実行する Prisma クライアント
 * @param now - 停止放置判定に使う基準時刻
 * @returns サービス・異常種別ごとに集約した対応が必要な項目一覧 (新しい順)
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
      where: { OR: [{ errorMessage: { not: null } }, { failedCount: { gt: 0 } }] },
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
    }),
  ])

  const occurrences: RawOccurrence[] = [
    ...toStaleOccurrences(
      runningCrawlRuns as StaleCandidateRun[],
      'crawler',
      (id) => `/crawl-runs/${id}`,
      now,
    ),
    ...toFailedRunOccurrences(
      failedCrawlRuns as FailedRun[],
      'crawler',
      (id) => `/crawl-runs/${id}`,
    ),
    ...toStaleOccurrences(
      runningBlockRuns as StaleCandidateRun[],
      'blocker',
      (id) => `/block-runs/${id}`,
      now,
    ),
    ...toFailedRunOccurrences(
      failedBlockRuns as FailedRun[],
      'blocker',
      (id) => `/block-runs/${id}`,
    ),
    ...toStaleOccurrences(
      runningWeeklyAnalysisRuns as StaleCandidateRun[],
      'weekly_analysis',
      () => '/weekly-runs',
      now,
    ),
    ...toFailedRunOccurrences(
      terminalWeeklyAnalysisRuns as TerminalWeeklyAnalysisRun[],
      'weekly_analysis',
      () => '/weekly-runs',
    ),
  ]

  for (const accountRun of warnedCrawlAccountRuns as CrawlAccountWarning[]) {
    occurrences.push({
      kind: 'account_warning',
      service: 'crawler',
      occurredAt: accountRun.startedAt,
      href: `/crawl-runs/${accountRun.crawlRunId}`,
    })
  }

  for (const accountRun of failedBlockAccountRuns as BlockAccountFailure[]) {
    occurrences.push({
      kind: 'block_failure',
      service: 'blocker',
      occurredAt: accountRun.startedAt,
      href: `/block-runs/${accountRun.blockRunId}`,
    })
  }

  return summarize(occurrences)
    .toSorted((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, RECENT_LIMIT)
}
