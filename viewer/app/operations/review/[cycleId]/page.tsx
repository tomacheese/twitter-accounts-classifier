import React from 'react'
import { notFound } from 'next/navigation'
import { getPrismaClient } from '@/lib/prisma'
import { getWeeklyReviewCycleDetail } from '@/lib/queries/operation-cycles'
import { ErrorFallback } from '../../../components/error-fallback'
import { OperationCycleDetail } from '../../cycle-detail-view'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'

interface WeeklyReviewCycleDetailPageProps {
  params: Promise<{ cycleId: string }>
}

/**
 * weekly_review Cycle 詳細画面。
 * @param props - Next.js の dynamic route params
 * @returns 描画された Cycle 詳細画面
 */
export default async function WeeklyReviewCycleDetailPage({
  params,
}: WeeklyReviewCycleDetailPageProps): Promise<React.ReactElement> {
  if (!isNewUiSectionEnabled('operations')) notFound()

  const { cycleId } = await params
  const prisma = getPrismaClient()

  const detail = await (async () => {
    try {
      return await getWeeklyReviewCycleDetail(prisma, cycleId)
    } catch (error) {
      console.error('Failed to load the weekly review cycle detail:', error)
      return undefined
    }
  })()

  if (detail === undefined) {
    return <ErrorFallback message="Failed to load the weekly review cycle detail." />
  }
  if (!detail) notFound()

  return (
    <div className="flex flex-col gap-6">
      <OperationCycleDetail detail={detail} />
      {detail.quality ? (
        <section aria-labelledby="weekly-review-quality-heading">
          <h2 id="weekly-review-quality-heading" className="text-lg font-semibold">
            Review quality
          </h2>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Strategy</dt>
              <dd>{detail.quality.strategyVersion}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Planned / reviewed</dt>
              <dd>
                {detail.quality.plannedSampleCount.toLocaleString()} /{' '}
                {detail.quality.reviewedSampleCount.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Random / targeted</dt>
              <dd>
                {detail.quality.randomAuditCount.toLocaleString()} /{' '}
                {detail.quality.targetedAuditCount.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Uncertain / skipped</dt>
              <dd>
                {detail.quality.uncertainCount.toLocaleString()} /{' '}
                {detail.quality.skippedCount.toLocaleString()}
              </dd>
            </div>
          </dl>
          {detail.quality.incompletePhases.length > 0 ? (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
              Incomplete phases: {detail.quality.incompletePhases.join(', ')}
            </p>
          ) : null}
        </section>
      ) : null}
      <section aria-labelledby="weekly-review-findings-heading">
        <h2 id="weekly-review-findings-heading" className="text-lg font-semibold">
          Findings
        </h2>
        <p className="mt-2 whitespace-pre-wrap text-gray-800 dark:text-gray-300">
          {detail.findings ?? 'No findings recorded.'}
        </p>
      </section>
    </div>
  )
}
