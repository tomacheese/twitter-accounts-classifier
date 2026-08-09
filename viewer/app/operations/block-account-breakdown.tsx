import type { BlockAccountRunView } from '@/lib/queries/operation-cycles'
import { StatusBadge } from '../components/status-badge'

/**
 * Block Cycle の実行元アカウント別の最新試行結果を表示する。
 * @param props - username ごとに最新試行へ畳み込み済みの BlockAccountRun 一覧
 * @returns 実行元アカウント別のブロック件数テーブル
 */
export function BlockAccountBreakdown({
  accountRuns,
}: {
  accountRuns: BlockAccountRunView[]
}): React.ReactElement {
  return (
    <section aria-labelledby="block-account-breakdown-heading">
      <h2 id="block-account-breakdown-heading" className="text-lg font-semibold">
        Account breakdown
      </h2>
      {accountRuns.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No account runs recorded.</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-100 text-left dark:bg-gray-700">
              <tr>
                <th className="p-2">Username</th>
                <th className="p-2">Status</th>
                <th className="p-2">Candidates</th>
                <th className="p-2">Blocked</th>
                <th className="p-2">Failed</th>
                <th className="p-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {accountRuns.map((accountRun) => (
                <tr key={accountRun.id} className="border-t dark:border-gray-700">
                  <td className="p-2">@{accountRun.username}</td>
                  <td className="p-2">
                    <StatusBadge status={accountRun.status} />
                  </td>
                  <td className="p-2">{accountRun.candidatesCount.toLocaleString()}</td>
                  <td className="p-2">{accountRun.blockedCount.toLocaleString()}</td>
                  <td className="p-2">{accountRun.failedCount.toLocaleString()}</td>
                  <td className="p-2">{accountRun.errorMessage ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
