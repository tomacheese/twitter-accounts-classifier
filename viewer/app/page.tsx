import { Suspense } from 'react'
import {
  DashboardSummary,
  DashboardSummarySkeleton,
  RecentCrawlRuns,
  RecentWeeklyRuns,
  RunListSkeleton,
} from './components/dashboard-sections'

export const dynamic = 'force-dynamic'

export default function DashboardPage(): React.ReactElement {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Dashboard</h1>
      <Suspense fallback={<DashboardSummarySkeleton />}>
        <DashboardSummary />
      </Suspense>
      <Suspense
        fallback={
          <RunListSkeleton
            headingId="recent-weekly-runs-heading"
            title="Recent weekly runs"
            contentLineCount={4}
          />
        }
      >
        <RecentWeeklyRuns />
      </Suspense>
      <Suspense
        fallback={
          <RunListSkeleton
            headingId="recent-crawl-runs-heading"
            title="Recent crawl runs"
            contentLineCount={1}
          />
        }
      >
        <RecentCrawlRuns />
      </Suspense>
    </div>
  )
}
