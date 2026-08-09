import React from 'react'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getPrismaClient } from '@/lib/prisma'
import { getCrawlCycleDetail } from '@/lib/queries/operation-cycles'
import { getCrawlAccountRuns, type CrawlAccountRunView } from '@/lib/queries/crawl-drilldown'
import { formatDuration } from '@/lib/format-duration'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import { ErrorFallback } from '../../../components/error-fallback'
import { StatusBadge } from '../../../components/status-badge'
import { OperationCycleDetail } from '../../cycle-detail-view'

interface CrawlCycleDetailPageProps {
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
 * @param durationMs - ミリ秒
 * @returns `formatDuration` に載せるための人間が読める経過時間
 */
function formatMillis(durationMs: number): string {
  return formatDuration(new Date(0), new Date(durationMs))
}

/**
 * @param warningCounts - type ごとの警告件数
 * @returns 展開可能な警告集計バッジ
 */
function WarningCountsCell({
  warningCounts,
}: {
  warningCounts: CrawlAccountRunView['warningCounts']
}): React.ReactElement {
  const entries = Object.entries(warningCounts)
  if (entries.length === 0) return <>—</>

  const total = entries.reduce((sum, [, count]) => sum + count, 0)
  return (
    <details>
      <summary className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400">
        {total} warning(s)
      </summary>
      <ul className="mt-1 list-disc pl-4">
        {entries.map(([type, count]) => (
          <li key={type}>
            {type} × {count}
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * @param phaseDurations - phase ごとの duration
 * @returns 展開可能な phase 別 duration
 */
function PhaseDurationsCell({
  phaseDurations,
}: {
  phaseDurations: CrawlAccountRunView['phaseDurations']
}): React.ReactElement {
  if (phaseDurations.length === 0) return <>—</>

  return (
    <details>
      <summary className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400">
        {phaseDurations.length} phase(s)
      </summary>
      <ul className="mt-1 list-disc pl-4">
        {phaseDurations.map((phase) => (
          <li key={phase.phase}>
            {phase.phase}: {phase.durationMs === null ? '—' : formatMillis(phase.durationMs)}
            {phase.retryWaitMs === null ? '' : ` (retry wait ${formatMillis(phase.retryWaitMs)})`}
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * crawl Cycle 詳細画面。
 * @param props - Next.js の dynamic route params と searchParams
 * @returns 描画された Cycle 詳細画面
 */
export default async function CrawlCycleDetailPage({
  params,
  searchParams,
}: CrawlCycleDetailPageProps): Promise<React.ReactElement> {
  if (!isNewUiSectionEnabled('operations')) notFound()

  const { cycleId } = await params
  const { shown } = await searchParams
  const prisma = getPrismaClient()

  const loaded = await (async () => {
    try {
      const detail = await getCrawlCycleDetail(prisma, cycleId)
      if (!detail) return { detail: null, accountRuns: [] as CrawlAccountRunView[] }
      const accountRuns = await getCrawlAccountRuns(prisma, detail.sourceId)
      return { detail, accountRuns }
    } catch (error) {
      console.error('Failed to load the crawl cycle detail:', error)
      return undefined
    }
  })()

  if (loaded === undefined) {
    return <ErrorFallback message="Failed to load the crawl cycle detail." />
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
                  <th className="p-2">Recommended</th>
                  <th className="p-2">Following tl</th>
                  <th className="p-2">Trending</th>
                  <th className="p-2">Replies</th>
                  <th className="p-2">Profiles</th>
                  <th className="p-2">Labels applied</th>
                  <th className="p-2">Following synced</th>
                  <th className="p-2">Followers synced</th>
                  <th className="p-2">Blocks synced</th>
                  <th className="p-2">Warnings</th>
                  <th className="p-2">Phase durations</th>
                </tr>
              </thead>
              <tbody>
                {visibleAccountRuns.map((run) => (
                  <tr key={run.id} className="border-t dark:border-gray-700">
                    <td className="p-2">{run.username}</td>
                    <td className="p-2">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="p-2">{run.recommendedCount}</td>
                    <td className="p-2">{run.followingCount}</td>
                    <td className="p-2">{run.trendingCount}</td>
                    <td className="p-2">{run.replyCount}</td>
                    <td className="p-2">{run.profileCount}</td>
                    <td className="p-2">{run.labelsAppliedCount}</td>
                    <td className="p-2">{run.followingSynced ? 'yes' : 'no'}</td>
                    <td className="p-2">{run.followersSynced ? 'yes' : 'no'}</td>
                    <td className="p-2">{run.blocksSynced ? 'yes' : 'no'}</td>
                    <td className="p-2">
                      <WarningCountsCell warningCounts={run.warningCounts} />
                    </td>
                    <td className="p-2">
                      <PhaseDurationsCell phaseDurations={run.phaseDurations} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {loaded.accountRuns.length > shownCount && (
              <div className="mt-2">
                <Link
                  href={`/operations/crawl/${cycleId}?shown=${shownCount + ACCOUNT_RUNS_PAGE_SIZE}`}
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
