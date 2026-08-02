import { notFound } from 'next/navigation'
import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import { getCrawlRunDetail } from '@/lib/queries/crawl-runs'
import { ErrorFallback } from '../../components/error-fallback'
import { StatusBadge } from '../../components/status-badge'

/** The warning types the crawler emits, one per failure site. */
type CrawlWarningType =
  | 'recommended_timeline_failed'
  | 'following_timeline_failed'
  | 'trending_timeline_failed'
  | 'author_processing_failed'
  | 'own_account_sync_failed'
  | 'following_sync_failed'
  | 'followers_sync_failed'

/**
 * One structured warning recorded against a `CrawlAccountRun`, as persisted in its
 * `warnings` JSON column. Mirrors `CrawlWarning` in
 * `crawler/db/crawl-run-repository.ts` — duplicated here since the crawler and viewer
 * are separate packages with no shared TypeScript project reference.
 */
interface CrawlWarning {
  type: CrawlWarningType
  message: string
  username?: string
  authorId?: string
  errorMessage: string
  /** The raw HTTP response body that caused the failure, when the crawler captured one. */
  rawResponseSnippet?: string
  /** The crawler build (APPLICATION_VERSION) that produced this specific warning. */
  appVersion?: string
}

/**
 * Groups a flat warning list by `type`, preserving each group's first-seen order.
 * @param warnings - the account run's warnings, in the order they were recorded
 * @returns each distinct type paired with every warning of that type, in encounter order
 */
function groupWarningsByType(warnings: CrawlWarning[]): [CrawlWarningType, CrawlWarning[]][] {
  const groups = new Map<CrawlWarningType, CrawlWarning[]>()
  for (const warning of warnings) {
    const group = groups.get(warning.type) ?? []
    group.push(warning)
    groups.set(warning.type, group)
  }
  return [...groups.entries()]
}

const ACCOUNT_RUN_COLUMNS = [
  'Username',
  'Status',
  'Recommended timeline tweets',
  'Following timeline tweets',
  'Trending timeline tweets',
  'Replies',
  'Profiles',
  'Labels applied',
  'Following graph synced',
  'Followers graph synced',
  'Warnings',
  'Error',
] as const

/**
 * Formats the elapsed time between two timestamps as e.g. "1h 04m 12s", or "4m 12s"
 * when the duration is under an hour (the leading "0h " is omitted, not zero-padded).
 * @param startedAt - the start timestamp
 * @param finishedAt - the end timestamp
 * @returns the elapsed duration, human-readable
 */
function formatDuration(startedAt: Date, finishedAt: Date): string {
  const totalSeconds = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = hours > 0 ? [`${hours}h`, `${String(minutes).padStart(2, '0')}m`] : [`${minutes}m`]
  parts.push(`${String(seconds).padStart(2, '0')}s`)
  return parts.join(' ')
}

/**
 * Crawl run detail page: one run's overall outcome plus its full per-account
 * breakdown.
 * @param props - the route's `id` path parameter
 * @returns the rendered crawl run detail page
 */
export default async function CrawlRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params
  let run: Awaited<ReturnType<typeof getCrawlRunDetail>>
  try {
    run = await getCrawlRunDetail(getPrismaClient(), id)
  } catch (error) {
    // Log the full error server-side but show the client a generic message:
    // error.message can leak SQL/connection details from the driver.
    console.error('Failed to load crawl run detail:', error)
    return <ErrorFallback message="Failed to load the crawl run." />
  }
  if (!run) {
    notFound()
  }

  const statusCounts: Partial<Record<string, number>> = {}
  for (const accountRun of run.accountRuns) {
    statusCounts[accountRun.status] = (statusCounts[accountRun.status] ?? 0) + 1
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/crawl-runs" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
        ← Back to crawl runs
      </Link>

      <section className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Crawl run</h1>
          <StatusBadge status={run.status} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Started at</dt>
            <dd>{formatDateTime(run.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Finished at</dt>
            <dd>{run.finishedAt ? formatDateTime(run.finishedAt) : '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Duration</dt>
            <dd>{run.finishedAt ? formatDuration(run.startedAt, run.finishedAt) : '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Accounts processed</dt>
            <dd>{run.accountRuns.length.toLocaleString()}</dd>
          </div>
        </dl>
        {run.accountRuns.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2 text-sm">
            {Object.entries(statusCounts).map(([status, count]) => (
              <span key={status} className="flex items-center gap-1">
                <StatusBadge status={status} /> × {count}
              </span>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Accounts</h2>
        {run.accountRuns.length > 0 && (
          <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
            The timeline-tweet columns count tweets fetched this cycle from each timeline; they are
            unrelated to the follow/follower graph. The synced columns report whether that graph
            sync step succeeded — see an account&apos;s own page for its actual following/followers
            counts.
          </p>
        )}
        {run.accountRuns.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No accounts were processed in this run.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-gray-100 text-left dark:bg-gray-700">
                <tr>
                  {ACCOUNT_RUN_COLUMNS.map((column) => (
                    <th key={column} className="p-2">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {run.accountRuns.map((accountRun) => {
                  const warnings = Array.isArray(accountRun.warnings)
                    ? (accountRun.warnings as unknown as CrawlWarning[])
                    : []
                  return (
                    <tr key={accountRun.id} className="border-t dark:border-gray-700">
                      <td className="p-2">{accountRun.username}</td>
                      <td className="p-2">
                        <StatusBadge status={accountRun.status} />
                      </td>
                      <td className="p-2">{accountRun.recommendedCount}</td>
                      <td className="p-2">{accountRun.followingCount}</td>
                      <td className="p-2">{accountRun.trendingCount}</td>
                      <td className="p-2">{accountRun.replyCount}</td>
                      <td className="p-2">{accountRun.profileCount}</td>
                      <td className="p-2">{accountRun.labelsAppliedCount}</td>
                      <td className="p-2">{accountRun.followingSynced ? 'yes' : 'no'}</td>
                      <td className="p-2">{accountRun.followersSynced ? 'yes' : 'no'}</td>
                      <td className="p-2">
                        {warnings.length === 0 ? (
                          '—'
                        ) : (
                          <details>
                            <summary className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400">
                              {warnings.length} warning(s)
                            </summary>
                            <ul className="mt-1 space-y-1 pl-4">
                              {groupWarningsByType(warnings).map(([type, group]) => (
                                <li key={type}>
                                  <details>
                                    <summary className="cursor-pointer">
                                      {type} × {group.length}
                                    </summary>
                                    <ul className="mt-1 list-disc pl-4">
                                      {group.map((warning, index) => (
                                        // Warnings have no stable id of their own, and this
                                        // list never reorders or mutates after the initial
                                        // render, so an index key is safe here.
                                        <li key={index}>
                                          {warning.message}
                                          {warning.username
                                            ? ` (username: ${warning.username})`
                                            : ''}
                                          {warning.authorId
                                            ? ` (authorId: ${warning.authorId})`
                                            : ''}
                                          {' — '}
                                          {warning.errorMessage}
                                          {warning.appVersion
                                            ? ` (build: ${warning.appVersion})`
                                            : ''}
                                          {warning.rawResponseSnippet && (
                                            <details className="mt-1">
                                              <summary className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400">
                                                Raw response
                                              </summary>
                                              <pre className="mt-1 max-h-64 overflow-auto rounded bg-gray-100 p-2 text-xs whitespace-pre-wrap dark:bg-gray-900">
                                                {warning.rawResponseSnippet}
                                              </pre>
                                            </details>
                                          )}
                                        </li>
                                      ))}
                                    </ul>
                                  </details>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                      <td className="p-2">{accountRun.errorMessage ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
