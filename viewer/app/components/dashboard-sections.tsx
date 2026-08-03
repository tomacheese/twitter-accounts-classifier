import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { formatDuration } from '@/lib/format-duration'
import { getPrismaClient } from '@/lib/prisma'
import { getDashboardKpis, getLabelDistribution } from '@/lib/queries/dashboard'
import { getRecentWeeklyRuns } from '@/lib/queries/weekly-runs'
import { getRecentCrawlRuns } from '@/lib/queries/crawl-runs'
import { LabelDistributionChart } from './label-distribution-chart'
import { SectionRetry } from './section-retry'
import { StatTile } from './stat-tile'
import { StatusBadge } from './status-badge'

const RECENT_RUN_COUNT = 5

interface DashboardSectionErrorProps {
  headingId: string
  title: string
  message: string
}

function DashboardSectionError({
  headingId,
  title,
  message,
}: DashboardSectionErrorProps): React.ReactElement {
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950"
    >
      <h2 id={headingId} className="text-lg font-semibold">
        {title}
      </h2>
      <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
        {message}
      </p>
      <SectionRetry />
    </section>
  )
}

function LoadingStatus({ label }: { label: string }): React.ReactElement {
  return (
    <div aria-busy="true" aria-live="polite" role="status">
      <span className="sr-only">Loading {label}</span>
    </div>
  )
}

function Skeleton({ className }: { className: string }): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-gray-200 motion-reduce:animate-none dark:bg-gray-700 ${className}`}
    />
  )
}

export function DashboardSummarySkeleton(): React.ReactElement {
  return (
    <section aria-label="Dashboard summary">
      <LoadingStatus label="dashboard summary" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-3 h-7 w-24" />
          </div>
        ))}
      </div>
    </section>
  )
}

export function LabelDistributionSkeleton(): React.ReactElement {
  return (
    <section aria-labelledby="label-distribution-heading">
      <LoadingStatus label="label distribution" />
      <h2 id="label-distribution-heading" className="mb-3 text-lg font-semibold">
        Label distribution
      </h2>
      <div
        aria-hidden="true"
        className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <Skeleton className="h-64 w-full" />
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-5 w-48 max-w-full" />
          ))}
        </div>
      </div>
    </section>
  )
}

export function RunListSkeleton({
  headingId,
  title,
  contentLineCount,
}: {
  headingId: string
  title: string
  contentLineCount: number
}): React.ReactElement {
  return (
    <section aria-labelledby={headingId}>
      <LoadingStatus label={title} />
      <div className="mb-3 flex items-center justify-between">
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        <Skeleton className="h-5 w-12" />
      </div>
      <ul className="flex flex-col gap-2" aria-hidden="true">
        {Array.from({ length: RECENT_RUN_COUNT }, (_, index) => (
          <li
            key={index}
            className="rounded-lg border bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <Skeleton className="h-5 w-36" />
            <div className="mt-3 flex flex-col gap-2">
              {Array.from({ length: contentLineCount }, (_, lineIndex) => (
                <Skeleton key={lineIndex} className="h-5 w-full" />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export async function DashboardSummary(): Promise<React.ReactElement> {
  try {
    const kpis = await getDashboardKpis(getPrismaClient())

    return (
      <section aria-label="Dashboard summary">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Total accounts" value={kpis.totalAccounts.toLocaleString()} />
          <StatTile label="Total tweets" value={kpis.totalTweets.toLocaleString()} />
          <StatTile label="Labeled accounts" value={kpis.labeledAccounts.toLocaleString()} />
          <StatTile
            label="Last crawled"
            value={kpis.lastCrawledAt ? formatDateTime(kpis.lastCrawledAt) : '—'}
          />
        </div>
      </section>
    )
  } catch (error) {
    console.error('Failed to load dashboard summary:', error)
    return (
      <DashboardSectionError
        headingId="dashboard-summary-heading"
        title="Dashboard summary"
        message="Failed to load the dashboard summary."
      />
    )
  }
}

export async function LabelDistributionSection(): Promise<React.ReactElement> {
  try {
    const distribution = await getLabelDistribution(getPrismaClient())
    return (
      <section aria-labelledby="label-distribution-heading">
        <h2 id="label-distribution-heading" className="mb-3 text-lg font-semibold">
          Label distribution
        </h2>
        {distribution.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No labels have been evaluated yet.
          </p>
        ) : (
          <LabelDistributionChart entries={distribution} />
        )}
      </section>
    )
  } catch (error) {
    console.error('Failed to load label distribution:', error)
    return (
      <DashboardSectionError
        headingId="label-distribution-heading"
        title="Label distribution"
        message="Failed to load the label distribution."
      />
    )
  }
}

export async function RecentWeeklyRuns(): Promise<React.ReactElement> {
  try {
    const recentRuns = await getRecentWeeklyRuns(getPrismaClient(), RECENT_RUN_COUNT)
    return (
      <section aria-labelledby="recent-weekly-runs-heading">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="recent-weekly-runs-heading" className="text-lg font-semibold">
            Recent weekly runs
          </h2>
          <Link
            href="/weekly-runs"
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            View all
          </Link>
        </div>
        {recentRuns.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No weekly analysis runs recorded yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recentRuns.map((run) => (
              <li
                key={run.id}
                className="rounded-lg border bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800"
              >
                <p className="text-sm font-medium">{formatDateTime(run.startedAt)}</p>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {run.findings ? run.findings.slice(0, 160) : 'No findings recorded.'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  } catch (error) {
    console.error('Failed to load recent weekly runs:', error)
    return (
      <DashboardSectionError
        headingId="recent-weekly-runs-heading"
        title="Recent weekly runs"
        message="Failed to load recent weekly runs."
      />
    )
  }
}

export async function RecentCrawlRuns(): Promise<React.ReactElement> {
  try {
    const recentCrawlRuns = await getRecentCrawlRuns(getPrismaClient(), RECENT_RUN_COUNT)
    return (
      <section aria-labelledby="recent-crawl-runs-heading">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="recent-crawl-runs-heading" className="text-lg font-semibold">
            Recent crawl runs
          </h2>
          <Link
            href="/crawl-runs"
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            View all
          </Link>
        </div>
        {recentCrawlRuns.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No crawl runs recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recentCrawlRuns.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/crawl-runs/${run.id}`}
                  className="block rounded-lg border bg-white p-3 shadow-sm hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
                >
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{formatDateTime(run.startedAt)}</p>
                    <StatusBadge status={run.status} />
                    {run.status === 'running' && run.currentUsername && run.currentAccountStartedAt && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        → @{run.currentUsername} (
                        {formatDuration(run.currentAccountStartedAt, new Date())} elapsed)
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    {run.accountRunCount.toLocaleString()} account(s) processed
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  } catch (error) {
    console.error('Failed to load recent crawl runs:', error)
    return (
      <DashboardSectionError
        headingId="recent-crawl-runs-heading"
        title="Recent crawl runs"
        message="Failed to load recent crawl runs."
      />
    )
  }
}
