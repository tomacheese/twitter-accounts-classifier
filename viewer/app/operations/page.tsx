import Link from 'next/link'
import { getPrismaClient } from '@/lib/prisma'
import { listOperationCycles, type OperationCycleKind } from '@/lib/queries/operation-cycles'
import { formatDateTime } from '@/lib/format-date'
import { ErrorFallback } from '../components/error-fallback'

const KIND_TO_PATH: Record<string, string> = {
  crawl: 'crawl',
  weekly_review: 'review',
  block: 'block',
}

const VALID_KINDS: OperationCycleKind[] = ['crawl', 'weekly_review', 'block']

interface OperationsPageProps {
  searchParams: Promise<{ kind?: string; attentionRequired?: string }>
}

/**
 * Operations 一覧画面。running 中 Cycle があれば 15 秒、なければ 60 秒間隔で
 * ポーリングするクライアント側自動更新は本タスクの初期実装では省略し、
 * Server Component による都度取得のみを実装する。
 * @param props - `kind`/`attentionRequired` 検索パラメータ
 * @returns 描画された Operations 一覧画面
 */
export default async function OperationsPage({
  searchParams,
}: OperationsPageProps): Promise<React.ReactElement> {
  const params = await searchParams
  const kind = (VALID_KINDS as string[]).includes(params.kind ?? '')
    ? (params.kind as OperationCycleKind)
    : undefined
  const attentionRequired = params.attentionRequired === 'true'

  const prisma = getPrismaClient()
  try {
    const cycles = await listOperationCycles(prisma, { filters: { kind, attentionRequired } })

    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Operations</h1>
        {cycles.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No cycles to show yet.</p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-gray-100 dark:bg-gray-700">
              <tr>
                <th className="p-3">Kind</th>
                <th className="p-3">Status</th>
                <th className="p-3">Attention</th>
                <th className="p-3">Triggered at</th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((cycle) => (
                <tr key={cycle.id} className="border-t dark:border-gray-700">
                  <td className="p-3">
                    <Link
                      href={`/operations/${KIND_TO_PATH[cycle.kind] ?? cycle.kind}/${cycle.id}`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {cycle.kind}
                    </Link>
                  </td>
                  <td className="p-3">{cycle.status}</td>
                  <td className="p-3">{cycle.attentionRequired ? 'Yes' : 'No'}</td>
                  <td className="p-3">{formatDateTime(cycle.triggeredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    )
  } catch (error) {
    console.error('Failed to load operation cycles:', error)
    return <ErrorFallback message="Failed to load the operation cycles." />
  }
}
