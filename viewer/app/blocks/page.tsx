import Link from 'next/link'
import { getPrismaClient } from '@/lib/prisma'
import { listBlockRelations } from '@/lib/queries/block-relations'
import { formatDateTime } from '@/lib/format-date'
import { ErrorFallback } from '../components/error-fallback'
import { CursorPagination } from '../components/cursor-pagination'
import { notFound } from 'next/navigation'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'

// 指定しないと、DB 接続がないビルド時に next build が静的生成を試みてしまう。
export const dynamic = 'force-dynamic'

interface BlocksPageProps {
  searchParams: Promise<{ cursor?: string }>
}

/**
 * Blocks 一覧画面。`status: 'active'` の Block 関係のみを表示する。
 * Block Run の実行状態は Operations が正本のため、ここでは関係の現在状態のみ扱う。
 * @param props - `cursor` 検索パラメータ
 * @returns 描画された Blocks 一覧画面
 */
export default async function BlocksPage({
  searchParams,
}: BlocksPageProps): Promise<React.ReactElement> {
  if (!isNewUiSectionEnabled('blocks')) notFound()

  const params = await searchParams
  const prisma = getPrismaClient()
  try {
    const { items, nextCursor } = await listBlockRelations(prisma, { cursor: params.cursor })

    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Blocks</h1>
        {items.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No block relations to show.</p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-gray-100 dark:bg-gray-700">
              <tr>
                <th className="p-3">Blocker</th>
                <th className="p-3">Blocked</th>
                <th className="p-3">Status</th>
                <th className="p-3">Findings</th>
                <th className="p-3">Status changed at</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.blockId} className="border-t dark:border-gray-700">
                  <td className="p-3 font-mono">
                    <Link
                      href={`/blocks/${item.blockId}`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {item.normalizedBlockerScreenName}
                    </Link>
                  </td>
                  <td className="p-3 font-mono">{item.normalizedBlockedScreenName}</td>
                  <td className="p-3">{item.status}</td>
                  <td className="p-3">
                    {item.activeFindingCount > 0
                      ? `${item.activeFindingCount} (${item.highestFindingSeverity ?? 'unknown'})`
                      : '—'}
                  </td>
                  <td className="p-3">{formatDateTime(item.statusChangedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CursorPagination basePath="/blocks" currentParams={params} nextCursor={nextCursor} />
      </div>
    )
  } catch (error) {
    console.error('Failed to load block relations:', error)
    return <ErrorFallback message="Failed to load the block relations." />
  }
}
