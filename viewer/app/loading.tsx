import { DashboardSummarySkeleton, RunListSkeleton } from './components/dashboard-sections'

export default function Loading(): React.ReactElement {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Dashboard</h1>
      <DashboardSummarySkeleton />
      <RunListSkeleton
        headingId="recent-weekly-runs-heading"
        title="Recent weekly runs"
        contentLineCount={4}
      />
      <RunListSkeleton
        headingId="recent-crawl-runs-heading"
        title="Recent crawl runs"
        contentLineCount={1}
      />
    </div>
  )
}
