import React from 'react'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getPrismaClient } from '@/lib/prisma'
import { getBlockCycleDetail } from '@/lib/queries/operation-cycles'
import {
  getBlockAccountRunsWithActions,
  type BlockAccountRunView,
} from '@/lib/queries/block-drilldown'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import { ErrorFallback } from '../../../components/error-fallback'
import { StatusBadge } from '../../../components/status-badge'
import { OperationCycleDetail } from '../../cycle-detail-view'

interface BlockCycleDetailPageProps {
  params: Promise<{ cycleId: string }>
  searchParams: Promise<{ shown?: string }>
}

const ACCOUNT_RUNS_PAGE_SIZE = 20

/**
 * @param value - searchParams.shown の生の値
 * @returns 表示する account 数。指定が無い、または不正な値なら既定件数
 */
function parseShownCount(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ACCOUNT_RUNS_PAGE_SIZE
}

/**
 * @param actions - account 単位の action 一覧
 * @returns 展開可能な action 一覧テーブル
 */
function ActionsCell({ actions }: { actions: BlockAccountRunView['actions'] }): React.ReactElement {
  if (actions.length === 0) return <>—</>

  return (
    <details>
      <summary className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400">
        {actions.length} action(s)
      </summary>
      <table className="mt-1 w-full text-left text-xs">
        <thead>
          <tr>
            <th className="p-1">Blocked account ID</th>
            <th className="p-1">Label</th>
            <th className="p-1">Confidence</th>
            <th className="p-1">Result</th>
            <th className="p-1">Outbox status</th>
            <th className="p-1">Error</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action) => (
            <tr key={action.id} className="border-t dark:border-gray-700">
              <td className="p-1">{action.blockedId}</td>
              <td className="p-1">{action.labelKey}</td>
              <td className="p-1">{action.confidence}</td>
              <td className="p-1">
                <StatusBadge status={action.result} />
              </td>
              <td className="p-1">
                {action.outboxStatus ? <StatusBadge status={action.outboxStatus} /> : '—'}
              </td>
              <td className="p-1">{action.errorMessage ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

/**
 * block Cycle 詳細画面。
 * @param props - Next.js の dynamic route params と searchParams
 * @returns 描画された Cycle 詳細画面
 */
export default async function BlockCycleDetailPage({
  params,
  searchParams,
}: BlockCycleDetailPageProps): Promise<React.ReactElement> {
  if (!isNewUiSectionEnabled('operations')) notFound()

  const { cycleId } = await params
  const { shown } = await searchParams
  const prisma = getPrismaClient()

  const loaded = await (async () => {
    try {
      const detail = await getBlockCycleDetail(prisma, cycleId)
      if (!detail) return { detail: null, accountRuns: [] as BlockAccountRunView[] }
      const accountRuns = await getBlockAccountRunsWithActions(prisma, detail.sourceId)
      return { detail, accountRuns }
    } catch (error) {
      console.error('Failed to load the block cycle detail:', error)
      return undefined
    }
  })()

  if (loaded === undefined) {
    return <ErrorFallback message="Failed to load the block cycle detail." />
  }
  if (!loaded.detail) notFound()

  const shownCount = parseShownCount(shown)
  const visibleAccountRuns = loaded.accountRuns.slice(0, shownCount)

  return (
    <div className="flex flex-col gap-6">
      <OperationCycleDetail detail={loaded.detail} />

      <section aria-labelledby="account-runs-heading">
        <h2 id="account-runs-heading" className="text-lg font-semibold">
          Accounts
        </h2>
        {loaded.accountRuns.length === 0 ? (
          <p className="mt-2">No accounts were processed in this run.</p>
        ) : (
          <>
            <table className="mt-2 w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="p-2">Username</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Candidates</th>
                  <th className="p-2">Blocked</th>
                  <th className="p-2">Failed</th>
                  <th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleAccountRuns.map((run) => (
                  <tr key={run.id} className="border-t dark:border-gray-700">
                    <td className="p-2">{run.username}</td>
                    <td className="p-2">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="p-2">{run.candidatesCount}</td>
                    <td className="p-2">{run.blockedCount}</td>
                    <td className="p-2">{run.failedCount}</td>
                    <td className="p-2">
                      <ActionsCell actions={run.actions} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {loaded.accountRuns.length > shownCount && (
              <div className="mt-2">
                <Link
                  href={`/operations/block/${cycleId}?shown=${shownCount + ACCOUNT_RUNS_PAGE_SIZE}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  Show more
                </Link>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
