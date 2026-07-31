import type { CrawlRunStatus } from '@/lib/crawl-run-status'

const STATUS_STYLES: Partial<Record<CrawlRunStatus, string>> = {
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  success: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
}

const FALLBACK_STYLE = 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'

/**
 * Renders a `CrawlRun`/`CrawlAccountRun` status ('running' | 'success' | 'partial' |
 * 'failed') as a colored pill. Any other value falls back to a neutral gray pill
 * instead of throwing, since the underlying column is a plain string, not an enum.
 * @param props - the status string to render
 * @returns the rendered status badge
 */
export function StatusBadge({ status }: { status: string }): React.ReactElement {
  const style = STATUS_STYLES[status as CrawlRunStatus] ?? FALLBACK_STYLE
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {status}
    </span>
  )
}
