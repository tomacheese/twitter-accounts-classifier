import { notFound } from 'next/navigation'
import { getPrismaClient } from '@/lib/prisma'
import { getBlockCycleDetail } from '@/lib/queries/operation-cycles'
import { ErrorFallback } from '../../../components/error-fallback'
import { OperationCycleDetail } from '../../cycle-detail-view'

interface BlockCycleDetailPageProps {
  params: Promise<{ cycleId: string }>
}

/**
 * block Cycle 詳細画面。
 * @param props - Next.js の dynamic route params
 * @returns 描画された Cycle 詳細画面
 */
export default async function BlockCycleDetailPage({
  params,
}: BlockCycleDetailPageProps): Promise<React.ReactElement> {
  const { cycleId } = await params
  const prisma = getPrismaClient()

  const detail = await (async () => {
    try {
      return await getBlockCycleDetail(prisma, cycleId)
    } catch (error) {
      console.error('Failed to load the block cycle detail:', error)
      return undefined
    }
  })()

  if (detail === undefined) {
    return <ErrorFallback message="Failed to load the block cycle detail." />
  }
  if (!detail) notFound()

  return <OperationCycleDetail detail={detail} />
}
