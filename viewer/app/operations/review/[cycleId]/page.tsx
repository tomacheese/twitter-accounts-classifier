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
