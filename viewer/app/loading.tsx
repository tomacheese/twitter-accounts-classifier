import { DashboardSummarySkeleton } from './components/dashboard-kpi-section'

export default function Loading(): React.ReactElement {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Dashboard</h1>
      <p>Loading system status…</p>
      <p>Loading attention required…</p>
      <p>Loading latest crawl summary…</p>
      <p>Loading latest block summary…</p>
      <DashboardSummarySkeleton />
      <p>Loading label overview…</p>
    </div>
  )
}
