import Link from 'next/link'
import { getPrismaClient } from '@/lib/prisma'
import { getLabelDistribution, type LabelDistributionEntry } from '@/lib/queries/dashboard'
import { ErrorFallback } from '../components/error-fallback'

// このページは常に最新データを読むため、静的プリレンダリングの対象から外している。
// 指定しないと、DB 接続がないビルド時に next build が静的生成を試みてしまう。
export const dynamic = 'force-dynamic'

/**
 * @returns ラベル一覧ページの描画結果
 */
export default async function LabelsPage(): Promise<React.ReactElement> {
  let entries: LabelDistributionEntry[]
  try {
    entries = await getLabelDistribution(getPrismaClient())
  } catch (error) {
    // エラーの詳細はサーバー側のログにのみ残し、クライアントには一般的なメッセージだけを返す。error.message には SQL 接続情報などドライバー由来の詳細が含まれうるため。
    console.error('Failed to load label definitions:', error)
    return <ErrorFallback message="Failed to load label definitions." />
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Labels</h1>
      {entries.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No labels are registered yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-100 text-left dark:bg-gray-700">
              <tr>
                <th className="p-3">Key</th>
                <th className="p-3">Condition</th>
                <th className="p-3">Accounts labeled true</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const percentage =
                  entry.totalAccounts === 0
                    ? 0
                    : Math.round((entry.trueCount / entry.totalAccounts) * 100)
                return (
                  <tr key={entry.labelKey} className="border-t align-top dark:border-gray-700">
                    <td className="p-3 font-mono">{entry.labelKey}</td>
                    <td className="p-3">{entry.labelDescription}</td>
                    <td className="p-3 whitespace-nowrap">
                      <Link
                        href={`/accounts?label=${encodeURIComponent(entry.labelKey)}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {entry.trueCount}/{entry.totalAccounts} ({percentage}%)
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
