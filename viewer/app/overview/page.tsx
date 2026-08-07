import React from 'react'
import { getPrismaClient } from '../../lib/prisma'
import { getOverviewSnapshot } from '../../lib/queries/overview'
import { isNewUiSectionEnabled } from '../../lib/feature-flags'
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

/**
 * 新 UI の Overview 画面。旧ダッシュボードとは独立した URL (`/overview`) で提供し、
 * `isNewUiSectionEnabled('overview')` が false の場合は旧ダッシュボードをそのまま表示する
 * (Task 31 の URL 切り替えまでは両方を併設する)。
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
          <section aria-labelledby="operational-health-heading">
            <h2 id="operational-health-heading" className="text-lg font-semibold">
              Operational Health
            </h2>
            <p className="mt-2">
              {OPERATIONAL_STATUS_LABEL[snapshot.operationalStatus] ?? snapshot.operationalStatus}
            </p>
          </section>

          <section aria-labelledby="classification-quality-heading">
            <h2 id="classification-quality-heading" className="text-lg font-semibold">
              Classification Quality
            </h2>
            <p className="mt-2">
              {QUALITY_STATUS_LABEL[snapshot.qualityStatus] ?? snapshot.qualityStatus}
            </p>
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
              <ul className="mt-2 flex flex-col gap-1">
                {snapshot.latestPipeline.stages.map((stage) => (
                  <li key={stage.stageKey}>
                    {stage.stageKey}: {stage.status}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2">No pipeline cycle has run yet.</p>
            )}
          </section>

          <section aria-labelledby="data-freshness-heading">
            <h2 id="data-freshness-heading" className="text-lg font-semibold">
              Data Freshness
            </h2>
            <p className="mt-2">{snapshot.freshnessStatus}</p>
          </section>
        </>
      ) : (
        <p role="status">No overview data is available yet.</p>
      )}
    </div>
  )
}
