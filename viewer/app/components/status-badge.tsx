import React from 'react'
import type { CrawlRunStatus } from '@/lib/crawl-run-status'
import type { HealthStatus } from '@/lib/health-status'

type KnownStatus = CrawlRunStatus | Exclude<HealthStatus, 'unknown'>

/**
 * `satisfies` により、`HealthStatus`/`CrawlRunStatus` に新しい値が増えたら
 * ここでスタイルを追加するまでコンパイルが通らないようにしている。
 * `unknown` は素の文字列に由来する未知値と同じ意味であるため、
 * このマップには含めず `FALLBACK_STYLE` に委ねる。
 */
const STATUS_STYLES = {
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  success: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  healthy: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  degraded: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  stale: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  not_run: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
} satisfies Record<KnownStatus, string>

const FALLBACK_STYLE = 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'

/**
 * 対象カラムは enum ではなく素の文字列のため、
 * 未知の値でも例外にせずグレーのピルにフォールバックする。
 * @param props - 表示するステータス文字列
 * @returns 描画されたステータスバッジ
 */
export function StatusBadge({ status }: { status: string }): React.ReactElement {
  const style = (STATUS_STYLES as Record<string, string>)[status] ?? FALLBACK_STYLE
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {status}
    </span>
  )
}
