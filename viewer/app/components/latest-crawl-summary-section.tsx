import Link from 'next/link'
import React from 'react'
import type { LatestCrawlSummary } from '@/lib/queries/latest-crawl-summary'
import { StatTile } from './stat-tile'

/**
 * @param props - 直近のクロール実行要約。実行が一件も存在しなければ `null`
 * @returns 描画された直近クロール要約セクション
 */
export function LatestCrawlSummarySection({
  summary,
}: {
  summary: LatestCrawlSummary | null
}): React.ReactElement {
  return (
    <section>
      <h2 className="text-lg font-semibold">Latest crawl summary</h2>
      {summary === null ? (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No crawl runs recorded yet.</p>
      ) : (
        <>
          <div className="mt-2 grid gap-4 sm:grid-cols-3">
            <StatTile label="Accounts processed" value={summary.accountCount.toLocaleString()} />
            <StatTile label="Succeeded" value={summary.successCount.toLocaleString()} />
            <StatTile
              label="Partial or failed"
              value={summary.partialOrFailedCount.toLocaleString()}
            />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-4">
            <StatTile label="Recommended" value={summary.recommendedCount.toLocaleString()} />
            <StatTile label="Following" value={summary.followingCount.toLocaleString()} />
            <StatTile label="Trending" value={summary.trendingCount.toLocaleString()} />
            <StatTile label="Reply" value={summary.replyCount.toLocaleString()} />
            <StatTile label="Profile" value={summary.profileCount.toLocaleString()} />
            <StatTile label="Labels applied" value={summary.labelsAppliedCount.toLocaleString()} />
            <StatTile label="Warnings" value={summary.warningCount.toLocaleString()} />
            <StatTile
              label="Total processing time"
              value={`${Math.round(summary.totalDurationMs / 60_000).toLocaleString()} min`}
            />
          </div>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            App version: {summary.appVersions.length > 0 ? summary.appVersions.join(', ') : '-'}
          </p>
        </>
      )}
      <Link
        href="/crawl-runs"
        className="mt-2 inline-block text-sm text-blue-600 underline dark:text-blue-400"
      >
        View crawl run history
      </Link>
    </section>
  )
}
