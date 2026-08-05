import Link from 'next/link'
import React from 'react'
import { formatDateTime, formatRelativeTime } from '@/lib/format-date'
import { formatDuration } from '@/lib/format-duration'
import type { SystemStatusEntry, SystemStatusService } from '@/lib/queries/system-status'
import { LoadingStatus, Skeleton } from './skeleton'
import { StatusBadge } from './status-badge'

/**
 * `SystemStatusCard` と同じカード3枚のレイアウトを保つことで、
 * データ到着時に高さが変わらないようにする読み込み中プレースホルダー。
 * @returns 描画されたシステム状況セクションの読み込み表示
 */
export function SystemStatusSkeleton(): React.ReactElement {
  return (
    <section>
      <h2 className="text-lg font-semibold">System status</h2>
      <LoadingStatus label="system status" />
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <div className="mt-2 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

const SERVICE_LABELS: Record<SystemStatusService, string> = {
  crawler: 'Crawler',
  blocker: 'Blocker',
  weekly_analysis: 'Weekly analysis',
}

/**
 * `formatDuration` は開始・終了の Date 2つを取る形で用意されているため、
 * `SystemStatusEntry` が持つミリ秒の差分から、経過なしの仮想的な開始・終了時刻を作って渡している。
 */
function formatDurationMs(durationMs: number): string {
  return formatDuration(new Date(0), new Date(durationMs))
}

function SystemStatusCard({
  entry,
  now,
}: {
  entry: SystemStatusEntry
  now: Date
}): React.ReactElement {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{SERVICE_LABELS[entry.service]}</h3>
        <StatusBadge status={entry.healthStatus} />
      </div>
      <dl className="mt-2 space-y-1 text-sm">
        <div>
          <dt className="inline text-gray-500 dark:text-gray-400">Started: </dt>
          <dd className="inline">{entry.startedAt ? formatDateTime(entry.startedAt) : '—'}</dd>
        </div>
        <div>
          <dt className="inline text-gray-500 dark:text-gray-400">Finished: </dt>
          <dd className="inline">{entry.finishedAt ? formatDateTime(entry.finishedAt) : '—'}</dd>
        </div>
        <div>
          <dt className="inline text-gray-500 dark:text-gray-400">Last success: </dt>
          <dd
            className="inline"
            title={entry.lastSuccessAt ? formatDateTime(entry.lastSuccessAt) : undefined}
          >
            {entry.lastSuccessAt ? formatRelativeTime(entry.lastSuccessAt, now) : '—'}
          </dd>
        </div>
        <div>
          <dt className="inline text-gray-500 dark:text-gray-400">Last duration: </dt>
          <dd className="inline">
            {entry.lastDurationMs === null ? '—' : formatDurationMs(entry.lastDurationMs)}
          </dd>
        </div>
        {entry.errorMessage && (
          <div>
            <dt className="inline text-red-600 dark:text-red-400">Error: </dt>
            <dd className="inline text-red-600 dark:text-red-400" title={entry.errorMessage}>
              Error recorded
            </dd>
          </div>
        )}
      </dl>
      <Link
        href={entry.detailHref}
        className="mt-2 inline-block text-sm text-blue-600 underline dark:text-blue-400"
      >
        View details
      </Link>
    </div>
  )
}

/**
 * @param props - Crawler・Blocker・週次分析のシステム状況一覧
 * @returns 描画されたシステム状況セクション
 */
export function SystemStatusSection({
  entries,
}: {
  entries: SystemStatusEntry[]
}): React.ReactElement {
  const now = new Date()
  return (
    <section>
      <h2 className="text-lg font-semibold">System status</h2>
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        {entries.map((entry) => (
          <SystemStatusCard key={entry.service} entry={entry} now={now} />
        ))}
      </div>
    </section>
  )
}
