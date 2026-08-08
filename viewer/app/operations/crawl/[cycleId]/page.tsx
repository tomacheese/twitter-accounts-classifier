import { notFound } from 'next/navigation'
import { getPrismaClient } from '@/lib/prisma'
import { getCrawlCycleDetail } from '@/lib/queries/operation-cycles'
import { ErrorFallback } from '../../../components/error-fallback'
import { OperationCycleDetail } from '../../cycle-detail-view'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'

interface CrawlCycleDetailPageProps {
  params: Promise<{ cycleId: string }>
}

/**
 * crawl Cycle 詳細画面。
 * @param props - Next.js の dynamic route params
 * @returns 描画された Cycle 詳細画面
 */
export default async function CrawlCycleDetailPage({
  params,
}: CrawlCycleDetailPageProps): Promise<React.ReactElement> {
  if (!isNewUiSectionEnabled('operations')) notFound()

  const { cycleId } = await params
  const prisma = getPrismaClient()

  const detail = await (async () => {
    try {
      return await getCrawlCycleDetail(prisma, cycleId)
    } catch (error) {
      console.error('Failed to load the crawl cycle detail:', error)
      return undefined
    }
  })()

  if (detail === undefined) {
    return <ErrorFallback message="Failed to load the crawl cycle detail." />
  }
  if (!detail) notFound()

  return <OperationCycleDetail detail={detail} />
}
