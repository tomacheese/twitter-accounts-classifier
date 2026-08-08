import React from 'react'
import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import { getOverviewSnapshot } from '@/lib/queries/overview'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import DashboardPage from '../page'

export const dynamic = 'force-dynamic'

const OPERATIONAL_STATUS_LABEL: Record<string, string> = {
  healthy: 'Healthy',
  attention: 'Attention',
  critical: 'Critical',
  unknown: 'Unknown',
}

const QUALITY_STATUS_LABEL: Record<string, string> = {
  stable: 'Stable',
  watch: 'Watch',
  degraded: 'Degraded',
  unknown: 'Unknown',
}

const FRESHNESS_LABEL: Record<string, string> = {
  healthy: 'Current',
  delayed: 'Delayed',
  stale: 'Stale',
  failed: 'Failed',
  unknown: 'Unknown',
}

const PIPELINE_STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  running: 'Running',
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
  delayed: 'Delayed',
  stale: 'Stale',
  unknown: 'Unknown',
}

function pipelineStageLabel(stageKey: string): string {
  const labels: Record<string, string> = {
    crawl: 'Crawl',
    label_metrics: 'Label metrics',
    finding_generation: 'Finding generation',
    read_model_refresh: 'Read model refresh',
  }
  return labels[stageKey] ?? stageKey.replaceAll('_', ' ')
}

/**
 * 新 UI の Overview 画面。旧ダッシュボードとは独立した URL (`/overview`) で提供し、
 * `isNewUiSectionEnabled('overview')` が false の場合は旧ダッシュボードをそのまま表示する。
 * @returns Overview 画面
 */
export default async function OverviewPage(): Promise<React.JSX.Element> {
  if (!isNewUiSectionEnabled('overview')) {
    return <DashboardPage />
  }

  const prisma = getPrismaClient()
  const snapshot = await getOverviewSnapshot(prisma)

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold">Overview</h1>

      {snapshot ? (
        <>
          <section className="grid gap-4 md:grid-cols-3" aria-label="Current status">
            <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <h2 id="operational-health-heading" className="font-semibold">
                Operational health
              </h2>
              <p className="mt-2 text-lg">
                {OPERATIONAL_STATUS_LABEL[snapshot.operationalStatus] ?? snapshot.operationalStatus}
              </p>
            </div>
            <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <h2 id="classification-quality-heading" className="font-semibold">
                Classification quality
              </h2>
              <p className="mt-2 text-lg">
                {QUALITY_STATUS_LABEL[snapshot.qualityStatus] ?? snapshot.qualityStatus}
              </p>
            </div>
            <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <h2 className="font-semibold">Data freshness</h2>
              <p className="mt-2 text-lg">
                {FRESHNESS_LABEL[snapshot.freshnessStatus] ?? snapshot.freshnessStatus}
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Source data: {snapshot.sourceDataAt ? formatDateTime(snapshot.sourceDataAt) : '—'}{' '}
                JST
              </p>
            </div>
          </section>

          <section aria-labelledby="attention-queue-heading">
            <h2 id="attention-queue-heading" className="text-lg font-semibold">
              Attention Queue
            </h2>
            {snapshot.attention.length === 0 ? (
              <p className="mt-2">No items require attention.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {snapshot.attention.map((item) => (
                  <li key={`${item.sourceType}-${item.sourceId}`}>
                    <a href={item.detailHref} className="underline">
                      [{item.severity}] {item.summary}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="latest-pipeline-heading">
            <h2 id="latest-pipeline-heading" className="text-lg font-semibold">
              Latest Pipeline
            </h2>
            {snapshot.latestPipeline ? (
              <div className="mt-2 rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p>
                    Status:{' '}
                    <strong>
                      {PIPELINE_STATUS_LABEL[snapshot.latestPipeline.status] ??
                        snapshot.latestPipeline.status}
                    </strong>
                  </p>
                  <Link
                    href={`/operations/crawl/${snapshot.latestPipeline.cycleId}`}
                    className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                  >
                    View cycle details
                  </Link>
                </div>
                <ol className="mt-3 grid gap-2 md:grid-cols-2">
                  {snapshot.latestPipeline.stages.map((stage) => (
                    <li
                      key={stage.stageKey}
                      className="rounded border p-2 text-sm dark:border-gray-700"
                    >
                      <span className="font-medium">{pipelineStageLabel(stage.stageKey)}</span>:{' '}
                      {PIPELINE_STATUS_LABEL[stage.status] ?? stage.status}
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                No crawl pipeline cycle is recorded yet. Check Operations for other recent activity.
              </p>
            )}
          </section>
        </>
      ) : (
        <p role="status">No overview data is available yet.</p>
      )}
    </div>
  )
}
