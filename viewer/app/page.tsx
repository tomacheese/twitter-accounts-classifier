import React, { Suspense } from 'react'
import { getPrismaClient } from '../lib/prisma'
import { getSystemStatus } from '../lib/queries/system-status'
import { getAttentionRequiredItems } from '../lib/queries/attention-required'
import { getLatestCrawlSummary } from '../lib/queries/latest-crawl-summary'
import { getLatestBlockSummary } from '../lib/queries/latest-block-summary'
import { getTopLabelOverview } from '../lib/queries/dashboard'
import { SystemStatusSection, SystemStatusSkeleton } from './components/system-status-section'
import {
  AttentionRequiredSection,
  AttentionRequiredSkeleton,
} from './components/attention-required-section'
import {
  LatestCrawlSummarySection,
  LatestCrawlSummarySkeleton,
} from './components/latest-crawl-summary-section'
import {
  LatestBlockSummarySection,
  LatestBlockSummarySkeleton,
} from './components/latest-block-summary-section'
import { DashboardSummary, DashboardSummarySkeleton } from './components/dashboard-kpi-section'
import { LabelOverviewSection, LabelOverviewSkeleton } from './components/label-overview-section'
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
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Dashboard</h1>
      <Suspense fallback={<SystemStatusSkeleton />}>
        <SystemStatusSectionData />
      </Suspense>
      <Suspense fallback={<AttentionRequiredSkeleton />}>
        <AttentionRequiredSectionData />
      </Suspense>
      <Suspense fallback={<LatestCrawlSummarySkeleton />}>
        <LatestCrawlSummarySectionData />
      </Suspense>
      <Suspense fallback={<LatestBlockSummarySkeleton />}>
        <LatestBlockSummarySectionData />
      </Suspense>
      <Suspense fallback={<DashboardSummarySkeleton />}>
        <DashboardSummary />
      </Suspense>
      <Suspense fallback={<LabelOverviewSkeleton />}>
        <LabelOverviewSectionData />
      </Suspense>
    </div>
  )
}
