import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import { getAllWeeklyRuns } from '@/lib/queries/weekly-runs'
import { ErrorFallback } from '../components/error-fallback'

// This page always reads live data, so opt it out of static prerendering:
// without this, `next build` tries to statically generate it at build time,
// when no database connection is available.
export const dynamic = 'force-dynamic'

/**
 * Weekly analysis run history page: the full list of `WeeklyAnalysisRun`
 * records, most recent first, with each run's full findings text available
 * behind an expandable disclosure.
 * @returns the rendered weekly run history page
 */
export default async function WeeklyRunsPage(): Promise<React.ReactElement> {
  let runs: Awaited<ReturnType<typeof getAllWeeklyRuns>>
  try {
    runs = await getAllWeeklyRuns(getPrismaClient())
  } catch (error) {
    // Log the full error server-side but show the client a generic message:
    // error.message can leak SQL/connection details from the driver.
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
