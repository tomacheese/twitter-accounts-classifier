import { AttentionRequiredSkeleton } from './components/attention-required-section'
import { DashboardSummarySkeleton } from './components/dashboard-kpi-section'
import { LabelOverviewSkeleton } from './components/label-overview-section'
import { LatestBlockSummarySkeleton } from './components/latest-block-summary-section'
import { LatestCrawlSummarySkeleton } from './components/latest-crawl-summary-section'
import { SystemStatusSkeleton } from './components/system-status-section'

export default function Loading(): React.ReactElement {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Dashboard</h1>
      <SystemStatusSkeleton />
      <AttentionRequiredSkeleton />
      <LatestCrawlSummarySkeleton />
      <LatestBlockSummarySkeleton />
      <DashboardSummarySkeleton />
      <LabelOverviewSkeleton />
    </div>
  )
}
