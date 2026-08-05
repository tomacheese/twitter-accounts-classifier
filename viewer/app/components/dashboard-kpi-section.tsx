import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import { getDashboardKpis } from '@/lib/queries/dashboard'
import { SectionRetry } from './section-retry'
import { StatTile } from './stat-tile'

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
