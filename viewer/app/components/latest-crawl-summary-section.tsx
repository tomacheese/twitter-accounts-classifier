import Link from 'next/link'
import React from 'react'
import type { LatestCrawlSummary } from '@/lib/queries/latest-crawl-summary'
import { LoadingStatus, Skeleton } from './skeleton'
import { StatTile } from './stat-tile'

/**
 * 実データの2段組タイルグリッド (3枚 + 8枚) と同じ形で描く読み込み中プレースホルダー。
 * @returns 描画された直近クロール要約セクションの読み込み表示
 */
export function LatestCrawlSummarySkeleton(): React.ReactElement {
  return (
    <section>
      <h2 className="text-lg font-semibold">Latest crawl summary</h2>
      <LoadingStatus label="latest crawl summary" />
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-3 h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
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
              tone={summary.partialOrFailedCount > 0 ? 'danger' : 'neutral'}
            />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-4">
            <StatTile label="Recommended" value={summary.recommendedCount.toLocaleString()} />
            <StatTile label="Following" value={summary.followingCount.toLocaleString()} />
            <StatTile label="Trending" value={summary.trendingCount.toLocaleString()} />
            <StatTile label="Reply" value={summary.replyCount.toLocaleString()} />
            <StatTile label="Profile" value={summary.profileCount.toLocaleString()} />
            <StatTile label="Labels applied" value={summary.labelsAppliedCount.toLocaleString()} />
            <StatTile
              label="Warnings"
              value={summary.warningCount.toLocaleString()}
              tone={summary.warningCount > 0 ? 'warning' : 'neutral'}
            />
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
