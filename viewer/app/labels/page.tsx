import Link from 'next/link'
import { getPrismaClient } from '@/lib/prisma'
import { getLabelDistribution, type LabelDistributionEntry } from '@/lib/queries/dashboard'
import { listLabelSummaries } from '@/lib/queries/label-summary'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import { ErrorFallback } from '../components/error-fallback'

// 指定しないと、DB 接続がないビルド時に next build が静的生成を試みてしまう。
export const dynamic = 'force-dynamic'

/**
 * 旧 Labels 一覧画面。`isNewUiSectionEnabled('labels')` が無効な間はこちらを表示する。
 * 新実装は {@link NewLabelsView} を参照。
 * @returns ラベル一覧ページの描画結果
 */
async function LegacyLabelsPage(): Promise<React.ReactElement> {
  let entries: LabelDistributionEntry[]
  try {
    entries = await getLabelDistribution(getPrismaClient())
  } catch (error) {
    // error.message には SQL 接続情報などドライバー由来の詳細が含まれうるため、
    // 詳細はサーバー側のログにのみ残し、クライアントには一般的なメッセージだけを返す。
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

/**
 * 新 Labels 一覧画面。label_summary read model を参照する。
 * @returns ラベル一覧画面の描画結果
 */
async function NewLabelsView(): Promise<React.ReactElement> {
  const prisma = getPrismaClient()
  try {
    const items = await listLabelSummaries(prisma)

    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">Labels</h1>
        {items.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No labels to show yet.</p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-gray-100 dark:bg-gray-700">
              <tr>
                <th className="p-3">Key</th>
                <th className="p-3">Prevalence</th>
                <th className="p-3">Quality</th>
                <th className="p-3">Findings</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.labelDefinitionId} className="border-t dark:border-gray-700">
                  <td className="p-3 font-mono">
                    <Link
                      href={`/labels/${encodeURIComponent(item.labelKey)}`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {item.labelKey}
                    </Link>
                  </td>
                  <td className="p-3">{(item.prevalence * 100).toFixed(1)}%</td>
                  <td className="p-3">{item.qualityStatus}</td>
                  <td className="p-3">
                    {item.activeFindingCount > 0
                      ? `${item.activeFindingCount} (${item.highestFindingSeverity ?? 'unknown'})`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    )
  } catch (error) {
    console.error('Failed to load label summaries:', error)
    return <ErrorFallback message="Failed to load label summaries." />
  }
}

/**
 * `isNewUiSectionEnabled('labels')` に応じて新旧いずれかの Labels 一覧画面を表示する。
 * @returns 表示すべき Labels 一覧画面
 */
export default function LabelsPage(): Promise<React.ReactElement> {
  return isNewUiSectionEnabled('labels') ? NewLabelsView() : LegacyLabelsPage()
}
