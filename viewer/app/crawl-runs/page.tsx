import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import { getAllCrawlRuns } from '@/lib/queries/crawl-runs'
import { ErrorFallback } from '../components/error-fallback'
import { StatusBadge } from '../components/status-badge'

// This page always reads live data, so opt it out of static prerendering:
// without this, `next build` tries to statically generate it at build time,
// when no database connection is available.
export const dynamic = 'force-dynamic'

/**
 * Crawl run history page: a lightweight summary of every `CrawlRun` record, most
 * recent first, each linking to its dedicated detail page for the per-account
 * breakdown.
 * @returns the rendered crawl run history page
 */
export default async function CrawlRunsPage(): Promise<React.ReactElement> {
  let runs: Awaited<ReturnType<typeof getAllCrawlRuns>>
  try {
    runs = await getAllCrawlRuns(getPrismaClient())
  } catch (error) {
    // Log the full error server-side but show the client a generic message:
    // error.message can leak SQL/connection details from the driver.
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
                    <StatusBadge status={run.status} />
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
