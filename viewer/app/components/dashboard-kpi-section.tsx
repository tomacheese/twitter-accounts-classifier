import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import { getDashboardKpis } from '@/lib/queries/dashboard'
import { DashboardSectionError } from './dashboard-section-error'
import { LoadingStatus, Skeleton } from './skeleton'
import { StatTile } from './stat-tile'

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

export async function DashboardSummary(): Promise<React.ReactElement> {
  try {
    const kpis = await getDashboardKpis(getPrismaClient())

    return (
      <section aria-label="Dashboard summary">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Total accounts" value={kpis.totalAccounts.toLocaleString()} />
          <StatTile label="Total tweets" value={kpis.totalTweets.toLocaleString()} />
          <StatTile
            label="Labeled accounts"
            value={kpis.labeledAccounts === null ? '—' : kpis.labeledAccounts.toLocaleString()}
          />
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
