import Link from 'next/link'
import React from 'react'
import { formatDateTime } from '@/lib/format-date'
import type { LatestBlockSummary } from '@/lib/queries/latest-block-summary'
import { StatTile } from './stat-tile'

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
            <StatTile label="Failed" value={summary.failureCount.toLocaleString()} />
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
