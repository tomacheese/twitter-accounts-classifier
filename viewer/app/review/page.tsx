import Link from 'next/link'
import { getPrismaClient } from '@/lib/prisma'
import { listReviewFindings, type ReviewFindingStatus } from '@/lib/queries/review-findings'
import { formatDateTime } from '@/lib/format-date'
import { ErrorFallback } from '../components/error-fallback'

const PAGE_SIZE = 25

interface ReviewPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * @param value - query string の値 (単一/複数/未指定のいずれもあり得る)
 * @returns 単一の文字列。未指定なら undefined
 */
function toSingleValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Quality Review 一覧画面。status/severity/type/primaryScopeType の絞り込みと
 * keyset pagination (cursor) の次ページリンクのみを実装し、
 * 詳細な filter UI は最小限のクエリパラメータ操作に留める。
 * @param props - Next.js の searchParams
 * @returns 描画された一覧画面
 */
export default async function ReviewPage({
  searchParams,
}: ReviewPageProps): Promise<React.ReactElement> {
  const params = await searchParams
  const status = toSingleValue(params.status)
  const cursor = toSingleValue(params.cursor)

  const prisma = getPrismaClient()

  try {
    const result = await listReviewFindings(prisma, {
      filters: {
        status: status ? (status.split(',') as ReviewFindingStatus[]) : undefined,
      },
      cursor,
      limit: PAGE_SIZE,
    })

    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Quality Review</h1>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-2">Type</th>
              <th className="p-2">Severity</th>
              <th className="p-2">Status</th>
              <th className="p-2">Scope</th>
              <th className="p-2">Last detected</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((item) => (
              <tr key={item.id} className="border-t">
                <td className="p-2">
                  <Link href={`/review/findings/${item.id}`} className="underline">
                    {item.type}
                  </Link>
                </td>
                <td className="p-2">{item.currentSeverity}</td>
                <td className="p-2">{item.status}</td>
                <td className="p-2">
                  {item.primaryScopeType}:{item.primaryScopeId}
                </td>
                <td className="p-2">{formatDateTime(item.lastDetectedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {result.nextCursor ? (
          <Link
            href={`/review?${new URLSearchParams({ ...(status ? { status } : {}), cursor: result.nextCursor }).toString()}`}
            className="underline"
          >
            Next page
          </Link>
        ) : null}
      </div>
    )
  } catch (error) {
    console.error('Failed to load review findings:', error)
    return <ErrorFallback message="Failed to load the quality review findings." />
  }
}
