import { permanentRedirect } from 'next/navigation'
import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import { getAllWeeklyRuns } from '@/lib/queries/weekly-runs'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import { ErrorFallback } from '../components/error-fallback'
import { StatusBadge } from '../components/status-badge'

// このページは常に最新データを読むため、
// 静的プリレンダリングの対象から外している。指定しないと、
// DB 接続がないビルド時に next build が静的生成を試みてしまう。
export const dynamic = 'force-dynamic'

/**
 * @returns 週次分析実行履歴ページの描画結果
 */
export default async function WeeklyRunsPage(): Promise<React.ReactElement> {
  if (isNewUiSectionEnabled('operations')) {
    permanentRedirect('/operations?kind=weekly_review')
  }

  let runs: Awaited<ReturnType<typeof getAllWeeklyRuns>>
  try {
    runs = await getAllWeeklyRuns(getPrismaClient())
  } catch (error) {
    // error.message には SQL 接続情報などドライバー由来の詳細が含まれうるため、
    // 詳細はサーバー側のログにのみ残し、クライアントには一般的なメッセージだけを返す。
    console.error('Failed to load weekly analysis runs:', error)
    return <ErrorFallback message="Failed to load weekly analysis runs." />
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Weekly analysis runs</h1>
      {runs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No weekly analysis runs recorded yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-100 text-left dark:bg-gray-700">
              <tr>
                <th className="p-3">Started at</th>
                <th className="p-3">Finished at</th>
                <th className="p-3">Commit SHA</th>
                <th className="p-3">Sampled accounts</th>
                <th className="p-3">Findings</th>
                <th className="p-3">Status</th>
                <th className="p-3">Phase</th>
                <th className="p-3">Error</th>
                <th className="p-3">Pull Request</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t dark:border-gray-700">
                  <td className="p-3">{formatDateTime(run.startedAt)}</td>
                  <td className="p-3">{run.finishedAt ? formatDateTime(run.finishedAt) : '—'}</td>
                  <td className="p-3 font-mono">
                    {run.commitSha ? run.commitSha.slice(0, 7) : '—'}
                  </td>
                  <td className="p-3">{run.sampledAccountCount.toLocaleString()}</td>
                  <td className="p-3">
                    <details>
                      <summary className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400">
                        View findings
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap text-gray-800 dark:text-gray-300">
                        {run.findings ?? 'No findings recorded.'}
                      </p>
                    </details>
                  </td>
                  <td className="p-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="p-3">{run.currentPhase ?? '—'}</td>
                  <td className="p-3 text-red-600 dark:text-red-400">{run.errorMessage ?? '—'}</td>
                  <td className="p-3">
                    {run.pullRequestUrl && run.pullRequestNumber ? (
                      <a
                        href={run.pullRequestUrl}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                        target="_blank"
                        rel="noreferrer"
                      >
                        #{run.pullRequestNumber}
                      </a>
                    ) : (
                      '—'
                    )}
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
