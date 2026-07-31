import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import {
  getDashboardKpis,
  getLabelDistribution,
  type LabelDistributionEntry,
} from '@/lib/queries/dashboard'
import { getRecentWeeklyRuns } from '@/lib/queries/weekly-runs'
import { getRecentCrawlRuns } from '@/lib/queries/crawl-runs'
import { StatTile } from './components/stat-tile'
import { LabelDistributionChart } from './components/label-distribution-chart'
import { ErrorFallback } from './components/error-fallback'
import { StatusBadge } from './components/status-badge'

const RECENT_RUN_COUNT = 5

// This page always reads live data, so opt it out of static prerendering:
// without this, `next build` tries to statically generate it at build time,
// when no database connection is available.
export const dynamic = 'force-dynamic'

/**
 * Dashboard page: KPI tiles, label distribution chart, and a preview of the
 * most recent weekly analysis runs.
 * @returns the rendered dashboard page
 */
export default async function DashboardPage(): Promise<React.ReactElement> {
  const prisma = getPrismaClient()
  let kpis: Awaited<ReturnType<typeof getDashboardKpis>>
  let distribution: LabelDistributionEntry[]
  let recentRuns: Awaited<ReturnType<typeof getRecentWeeklyRuns>>
  let recentCrawlRuns: Awaited<ReturnType<typeof getRecentCrawlRuns>>
  try {
    ;[kpis, distribution, recentRuns, recentCrawlRuns] = await Promise.all([
      getDashboardKpis(prisma),
      getLabelDistribution(prisma),
      getRecentWeeklyRuns(prisma, RECENT_RUN_COUNT),
      getRecentCrawlRuns(prisma, RECENT_RUN_COUNT),
    ])
  } catch (error) {
    // Log the full error server-side but show the client a generic message:
    // error.message can leak SQL/connection details from the driver.
    console.error('Failed to load dashboard data:', error)
    return <ErrorFallback message="Failed to load dashboard data." />
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Total accounts" value={kpis.totalAccounts.toLocaleString()} />
        <StatTile label="Total tweets" value={kpis.totalTweets.toLocaleString()} />
        <StatTile label="Labeled accounts" value={kpis.labeledAccounts.toLocaleString()} />
        <StatTile
          label="Last crawled"
          value={kpis.lastCrawledAt ? formatDateTime(kpis.lastCrawledAt) : '—'}
        />
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Label distribution</h2>
        {distribution.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No labels have been evaluated yet.
          </p>
        ) : (
          <LabelDistributionChart entries={distribution} />
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent weekly runs</h2>
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

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent crawl runs</h2>
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
    </div>
  )
}
