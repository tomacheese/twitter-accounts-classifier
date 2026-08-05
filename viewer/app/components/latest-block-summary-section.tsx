import Link from 'next/link'
import React from 'react'
import { formatDateTime } from '@/lib/format-date'
import type { LatestBlockSummary } from '@/lib/queries/latest-block-summary'
import { LoadingStatus, Skeleton } from './skeleton'
import { StatTile } from './stat-tile'

/**
 * 実データの4枚タイルグリッドと同じ形で描く読み込み中プレースホルダー。
 * @returns 描画された直近ブロック要約セクションの読み込み表示
 */
export function LatestBlockSummarySkeleton(): React.ReactElement {
  return (
    <section>
      <h2 className="text-lg font-semibold">Latest block summary</h2>
      <LoadingStatus label="latest block summary" />
      <div className="mt-2 grid gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-3 h-7 w-16" />
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * @param props - 直近の blocker 実行要約。実行が一件も存在しなければ `null`
 * @returns 描画された直近ブロック要約セクション
 */
export function LatestBlockSummarySection({
  summary,
}: {
  summary: LatestBlockSummary | null
}): React.ReactElement {
  return (
    <section>
      <h2 className="text-lg font-semibold">Latest block summary</h2>
      {summary === null ? (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No block runs recorded yet.</p>
      ) : (
        <>
          <div className="mt-2 grid gap-4 sm:grid-cols-4">
            <StatTile label="Candidates" value={summary.candidatesCount.toLocaleString()} />
            <StatTile label="Accounts processed" value={summary.accountRunCount.toLocaleString()} />
            <StatTile label="Blocked" value={summary.blockedCount.toLocaleString()} />
            <StatTile
              label="Failed"
              value={summary.failureCount.toLocaleString()}
              tone={summary.failureCount > 0 ? 'danger' : 'neutral'}
            />
          </div>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Last success: {summary.lastSuccessAt ? formatDateTime(summary.lastSuccessAt) : '—'}
          </p>
        </>
      )}
      <Link
        href="/block-runs"
        className="mt-2 inline-block text-sm text-blue-600 underline dark:text-blue-400"
      >
        View block run history
      </Link>
    </section>
  )
}
