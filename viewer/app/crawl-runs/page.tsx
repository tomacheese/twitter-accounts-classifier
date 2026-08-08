import Link from 'next/link'
import { permanentRedirect } from 'next/navigation'
import { isCurrentAccountStale } from '@/lib/crawl-run-progress'
import { formatDateTime } from '@/lib/format-date'
import { formatDuration } from '@/lib/format-duration'
import { getPrismaClient } from '@/lib/prisma'
import { getAllCrawlRuns } from '@/lib/queries/crawl-runs'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import { ErrorFallback } from '../components/error-fallback'
import { StatusBadge } from '../components/status-badge'

// このページは常に最新データを読むため、
// 静的プリレンダリングの対象から外している。指定しないと、
// DB 接続がないビルド時に next build が静的生成を試みてしまう。
export const dynamic = 'force-dynamic'

/**
 * @returns クロール実行履歴ページの描画結果
 */
export default async function CrawlRunsPage(): Promise<React.ReactElement> {
  if (isNewUiSectionEnabled('operations')) {
    permanentRedirect('/operations?kind=crawl')
  }

  let runs: Awaited<ReturnType<typeof getAllCrawlRuns>>
  try {
    runs = await getAllCrawlRuns(getPrismaClient())
  } catch (error) {
    // error.message には SQL 接続情報などドライバー由来の詳細が含まれうるため、
    // 詳細はサーバー側のログにのみ残し、クライアントには一般的なメッセージだけを返す。
    console.error('Failed to load crawl runs:', error)
    return <ErrorFallback message="Failed to load crawl runs." />
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Crawl runs</h1>
      {runs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No crawl runs recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-100 text-left dark:bg-gray-700">
              <tr>
                <th className="p-3">Started at</th>
                <th className="p-3">Finished at</th>
                <th className="p-3">Status</th>
                <th className="p-3">Accounts processed</th>
                <th className="p-3">Details</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t dark:border-gray-700">
                  <td className="p-3">{formatDateTime(run.startedAt)}</td>
                  <td className="p-3">{run.finishedAt ? formatDateTime(run.finishedAt) : '—'}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={run.status} />
                      {run.status === 'running' &&
                        run.currentUsername &&
                        run.currentAccountStartedAt &&
                        !isCurrentAccountStale(run.currentAccountStartedAt, new Date()) && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            → @{run.currentUsername} (
                            {formatDuration(run.currentAccountStartedAt, new Date())} elapsed)
                          </span>
                        )}
                    </div>
                  </td>
                  <td className="p-3">{run.accountRunCount.toLocaleString()}</td>
                  <td className="p-3">
                    <Link
                      href={`/crawl-runs/${run.id}`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      View details
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
