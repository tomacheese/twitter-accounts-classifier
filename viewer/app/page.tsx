import React, { Suspense } from 'react'
import { getPrismaClient } from '../lib/prisma'
import { getSystemStatus } from '../lib/queries/system-status'
import { getAttentionRequiredItems } from '../lib/queries/attention-required'
import { getLatestCrawlSummary } from '../lib/queries/latest-crawl-summary'
import { getLatestBlockSummary } from '../lib/queries/latest-block-summary'
import { getTopLabelOverview } from '../lib/queries/dashboard'
import { SystemStatusSection } from './components/system-status-section'
import { AttentionRequiredSection } from './components/attention-required-section'
import { LatestCrawlSummarySection } from './components/latest-crawl-summary-section'
import { LatestBlockSummarySection } from './components/latest-block-summary-section'
import { DashboardSummary, DashboardSummarySkeleton } from './components/dashboard-kpi-section'
import { LabelOverviewSection } from './components/label-overview-section'
import { DashboardSectionError } from './components/dashboard-section-error'

export const dynamic = 'force-dynamic'

const TOP_LABEL_LIMIT = 10

export async function SystemStatusSectionData(): Promise<React.JSX.Element> {
  const prisma = getPrismaClient()
  try {
    const entries = await getSystemStatus(prisma, new Date())
    return <SystemStatusSection entries={entries} />
  } catch (error) {
    console.error('Failed to load system status:', error)
    return (
      <DashboardSectionError
        headingId="system-status-heading"
        title="System status"
        message="Failed to load the system status."
      />
    )
  }
}

async function AttentionRequiredSectionData(): Promise<React.JSX.Element> {
  const prisma = getPrismaClient()
  try {
    const items = await getAttentionRequiredItems(prisma, new Date())
    return <AttentionRequiredSection items={items} />
  } catch (error) {
    console.error('Failed to load attention required items:', error)
    return (
      <DashboardSectionError
        headingId="attention-required-heading"
        title="Attention required"
        message="Failed to load the attention required items."
      />
    )
  }
}

async function LatestCrawlSummarySectionData(): Promise<React.JSX.Element> {
  const prisma = getPrismaClient()
  try {
    const summary = await getLatestCrawlSummary(prisma)
    return <LatestCrawlSummarySection summary={summary} />
  } catch (error) {
    console.error('Failed to load the latest crawl summary:', error)
    return (
      <DashboardSectionError
        headingId="latest-crawl-summary-heading"
        title="Latest crawl summary"
        message="Failed to load the latest crawl summary."
      />
    )
  }
}

async function LatestBlockSummarySectionData(): Promise<React.JSX.Element> {
  const prisma = getPrismaClient()
  try {
    const summary = await getLatestBlockSummary(prisma)
    return <LatestBlockSummarySection summary={summary} />
  } catch (error) {
    console.error('Failed to load the latest block summary:', error)
    return (
      <DashboardSectionError
        headingId="latest-block-summary-heading"
        title="Latest block summary"
        message="Failed to load the latest block summary."
      />
    )
  }
}

async function LabelOverviewSectionData(): Promise<React.JSX.Element> {
  const prisma = getPrismaClient()
  try {
    const entries = await getTopLabelOverview(prisma, TOP_LABEL_LIMIT)
    return <LabelOverviewSection entries={entries} />
  } catch (error) {
    console.error('Failed to load the label overview:', error)
    return (
      <DashboardSectionError
        headingId="label-overview-heading"
        title="Label overview"
        message="Failed to load the label overview."
      />
    )
  }
}

export default function DashboardPage(): React.JSX.Element {
  return (
    <main className="flex flex-col gap-8 p-8">
      <h1 className="sr-only">Dashboard</h1>
      <Suspense fallback={<p>Loading system status…</p>}>
        <SystemStatusSectionData />
      </Suspense>
      <Suspense fallback={<p>Loading attention required…</p>}>
        <AttentionRequiredSectionData />
      </Suspense>
      <Suspense fallback={<p>Loading latest crawl summary…</p>}>
        <LatestCrawlSummarySectionData />
      </Suspense>
      <Suspense fallback={<p>Loading latest block summary…</p>}>
        <LatestBlockSummarySectionData />
      </Suspense>
      <Suspense fallback={<DashboardSummarySkeleton />}>
        <DashboardSummary />
      </Suspense>
      <Suspense fallback={<p>Loading label overview…</p>}>
        <LabelOverviewSectionData />
      </Suspense>
    </main>
  )
}
