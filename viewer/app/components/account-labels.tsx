import React from 'react'
import { formatDateTime } from '@/lib/format-date'
import type { AccountDetailLabel } from '@/lib/queries/account-detail'

const BADGE_STYLES = {
  applied: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  inactive: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
} as const

/**
 * ラベル 1 件分のカードを描画する。
 * @param props - 表示するラベル (最新評価と再評価履歴を含む)
 * @returns ラベル 1 件分のカード
 */
function LabelCard({ label }: { label: AccountDetailLabel }): React.ReactElement {
  const tone: keyof typeof BADGE_STYLES = label.value ? 'applied' : 'inactive'
  return (
    <li className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <p className="font-medium">
        <span
          className={`mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[tone]}`}
        >
          {label.labelKey}
        </span>
        confidence {label.confidence.toFixed(2)}
      </p>
      <p className="mt-1 text-gray-600 dark:text-gray-400">{label.reason}</p>
      <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
        {label.method} · {label.ruleVersion} · {formatDateTime(label.labeledAt)}
      </p>
      {label.history.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-gray-500 dark:text-gray-400">
            履歴 ({label.history.length}件)
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {label.history.map((entry, index) => (
              <li key={index} className="border-t pt-2 dark:border-gray-700">
                <p>
                  {entry.value ? 'true' : 'false'} (confidence {entry.confidence.toFixed(2)})
                </p>
                <p className="mt-1 text-gray-500 dark:text-gray-400">{entry.reason}</p>
                <p className="mt-1 text-gray-400 dark:text-gray-500">
                  {entry.method} · {entry.ruleVersion} · {formatDateTime(entry.labeledAt)}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  )
}

/**
 * アカウント詳細ページのラベル一覧を表示する。
 * @param props - 表示するラベルの一覧 (labelDefinitionId ごとに集約済み)
 * @returns ラベル一覧セクションの中身
 */
export function AccountLabels({ labels }: { labels: AccountDetailLabel[] }): React.ReactElement {
  if (labels.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No labels recorded for this account.
      </p>
    )
  }

  const applied = labels.filter((label) => label.value)
  const inactive = labels.filter((label) => !label.value)

  return (
    <div className="flex flex-col gap-4">
      {applied.length > 0 && (
        <ul className="flex flex-col gap-2">
          {applied.map((label) => (
            <LabelCard key={label.labelKey} label={label} />
          ))}
        </ul>
      )}
      {inactive.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-gray-500 dark:text-gray-400">
            評価済みで非該当のラベル ({inactive.length}件)
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {inactive.map((label) => (
              <LabelCard key={label.labelKey} label={label} />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
