import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import { getAllBlockRuns } from '@/lib/queries/block-runs'
import { listBlocks } from '@/lib/queries/blocks'
import { ErrorFallback } from '../components/error-fallback'
import { StatusBadge } from '../components/status-badge'

const PAGE_SIZE = 20

// このページは常に最新データを読むため、
// 静的プリレンダリングの対象から外している。指定しないと、
// DB 接続がないビルド時に next build が静的生成を試みてしまう。
export const dynamic = 'force-dynamic'

/**
 * @param page - 表示するページ番号 (1始まり)
 * @returns このページネーションリンクのリンク先
 */
function buildBlocksPageHref(page: number): string {
  return `/block-runs?blocksPage=${page}`
}

/**
 * @param props - `blocksPage` 検索パラメータ (「Current blocks」セクションのページ番号)
 * @returns Block Runs タブの描画結果
 */
export default async function BlockRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ blocksPage?: string }>
}): Promise<React.ReactElement> {
  const params = await searchParams
  const blocksPage = Math.max(1, Math.trunc(Number(params.blocksPage)) || 1)

  const prisma = getPrismaClient()
  let blocks: Awaited<ReturnType<typeof listBlocks>>
  let runs: Awaited<ReturnType<typeof getAllBlockRuns>>
  try {
    ;[blocks, runs] = await Promise.all([
      listBlocks(prisma, { page: blocksPage, pageSize: PAGE_SIZE }),
      getAllBlockRuns(prisma),
    ])
  } catch (error) {
    // error.message には SQL 接続情報などドライバー由来の詳細が含まれうるため、
    // 詳細はサーバー側のログにのみ残し、クライアントには一般的なメッセージだけを返す。
    console.error('Failed to load block runs or current blocks:', error)
    return <ErrorFallback message="Failed to load block runs." />
  }

  const totalBlocksPages = Math.max(1, Math.ceil(blocks.totalCount / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Block Runs</h1>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Current blocks</h2>
        {blocks.totalCount === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No blocks recorded yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-gray-100 text-left dark:bg-gray-700">
                  <tr>
                    <th className="p-3">Blocker</th>
                    <th className="p-3">Blocked</th>
                    <th className="p-3">First seen</th>
                    <th className="p-3">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {blocks.items.map((block) => (
                    <tr key={block.id} className="border-t dark:border-gray-700">
                      <td className="p-3">
                        <Link
                          href={`/accounts/${block.blockerId}`}
                          className="text-blue-600 hover:underline dark:text-blue-400"
                        >
                          @{block.blockerScreenName}
                        </Link>
                      </td>
                      <td className="p-3">
                        <Link
                          href={`/accounts/${block.blockedId}`}
                          className="text-blue-600 hover:underline dark:text-blue-400"
                        >
                          @{block.blockedScreenName}
                        </Link>
                      </td>
                      <td className="p-3">{formatDateTime(block.firstSeenAt)}</td>
                      <td className="p-3">{formatDateTime(block.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
              <span>
                Page {blocksPage} of {totalBlocksPages}
              </span>
              <div className="flex gap-3">
                {blocksPage > 1 && (
                  <Link
                    href={buildBlocksPageHref(blocksPage - 1)}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Previous
                  </Link>
                )}
                {blocksPage < totalBlocksPages && (
                  <Link
                    href={buildBlocksPageHref(blocksPage + 1)}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Next
                  </Link>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No block runs recorded yet.</p>
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
                        href={`/block-runs/${run.id}`}
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
      </section>
    </div>
  )
}
