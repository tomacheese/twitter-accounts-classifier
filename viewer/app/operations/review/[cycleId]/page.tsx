import { notFound } from 'next/navigation'
import { getPrismaClient } from '@/lib/prisma'
import { getWeeklyReviewCycleDetail } from '@/lib/queries/operation-cycles'
import { ErrorFallback } from '../../../components/error-fallback'
import { OperationCycleDetail } from '../../cycle-detail-view'

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

  return <OperationCycleDetail detail={detail} />
}
