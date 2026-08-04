import { notFound } from 'next/navigation'
import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { formatDuration } from '@/lib/format-duration'
import { getPrismaClient } from '@/lib/prisma'
import { getBlockRunDetail } from '@/lib/queries/block-runs'
import { ErrorFallback } from '../../components/error-fallback'
import { StatusBadge } from '../../components/status-badge'

// このページは常に最新データを読むため、
// 静的プリレンダリングの対象から外している。
export const dynamic = 'force-dynamic'

const ACCOUNT_RUN_COLUMNS = [
  'Username',
  'Status',
  'Started at',
  'Finished at',
  'Duration',
  'Candidates',
  'Blocked',
  'Failed',
  'Error',
] as const

/**
 * @param props - ルートの `id` パスパラメータ
 * @returns Block run 詳細ページの描画結果
 */
export default async function BlockRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params
  let run: Awaited<ReturnType<typeof getBlockRunDetail>>
  try {
    run = await getBlockRunDetail(getPrismaClient(), id)
  } catch (error) {
    // error.message には SQL 接続情報などドライバー由来の詳細が含まれうるため、
    // 詳細はサーバー側のログにのみ残し、クライアントには一般的なメッセージだけを返す。
    console.error('Failed to load block run detail:', error)
    return <ErrorFallback message="Failed to load the block run." />
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
      <Link href="/block-runs" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
        ← Back to block runs
      </Link>

      <section className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Block run</h1>
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
                {run.accountRuns.map((accountRun) => (
                  <tr key={accountRun.id} className="border-t dark:border-gray-700">
                    <td className="p-2">{accountRun.username}</td>
                    <td className="p-2">
                      <StatusBadge status={accountRun.status} />
                    </td>
                    <td className="p-2">{formatDateTime(accountRun.startedAt)}</td>
                    <td className="p-2">
                      {accountRun.finishedAt ? formatDateTime(accountRun.finishedAt) : '—'}
                    </td>
                    <td className="p-2">
                      {accountRun.finishedAt
                        ? formatDuration(accountRun.startedAt, accountRun.finishedAt)
                        : '—'}
                    </td>
                    <td className="p-2">{accountRun.candidatesCount}</td>
                    <td className="p-2">{accountRun.blockedCount}</td>
                    <td className="p-2">
                      {accountRun.failures.length === 0 ? (
                        accountRun.failedCount
                      ) : (
                        <details>
                          <summary className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400">
                            {accountRun.failedCount} failure(s)
                          </summary>
                          <ul className="mt-1 list-disc space-y-1 pl-4">
                            {accountRun.failures.map((failure) => (
                              <li key={failure.id}>
                                @{failure.blockedScreenName} ({failure.labelKey}, confidence{' '}
                                {failure.confidence.toFixed(2)}) — {failure.errorMessage ?? '—'}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="p-2">{accountRun.errorMessage ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
