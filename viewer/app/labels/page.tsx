import React from 'react'
import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { formatPercentage } from '@/lib/format-percentage'
import { getPrismaClient } from '@/lib/prisma'
import { getLabelAggregateSnapshot, type LabelDistributionEntry } from '@/lib/queries/dashboard'
import { listLabelSummaries, type LabelSummaryListItem } from '@/lib/queries/label-summary'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import { ErrorFallback } from '../components/error-fallback'
import { ReadModelReadinessPanel } from '../components/read-model-readiness-panel'
import { ResponsiveTable, type ResponsiveTableColumn } from '../components/responsive-table'

// 指定しないと、DB 接続がないビルド時に next build が静的生成を試みてしまう。
export const dynamic = 'force-dynamic'

const legacyLabelColumns: ResponsiveTableColumn<LabelDistributionEntry>[] = [
  {
    key: 'key',
    header: 'Key',
    priority: 'primary',
    render: (entry) => <span className="font-mono">{entry.labelKey}</span>,
  },
  {
    key: 'accountsLabeledTrue',
    header: 'Accounts labeled true',
    priority: 'primary',
    render: (entry) => {
      const percentage = formatPercentage(
        entry.totalAccounts === 0 ? 0 : entry.trueCount / entry.totalAccounts,
      )
      return (
        <Link
          href={`/accounts?label=${encodeURIComponent(entry.labelKey)}`}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          {entry.trueCount}/{entry.totalAccounts} ({percentage})
        </Link>
      )
    },
  },
  {
    key: 'condition',
    header: 'Condition',
    priority: 'secondary',
    render: (entry) => entry.labelDescription,
  },
]

const newLabelColumns: ResponsiveTableColumn<LabelSummaryListItem>[] = [
  {
    key: 'key',
    header: 'Key',
    priority: 'primary',
    render: (item) => (
      <Link
        href={`/labels/${encodeURIComponent(item.labelKey)}`}
        className="font-mono text-blue-600 hover:underline dark:text-blue-400"
      >
        {item.labelKey}
      </Link>
    ),
  },
  {
    key: 'trueCount',
    header: 'True count',
    priority: 'primary',
    render: (item) => item.trueCount,
  },
  {
    key: 'coverage',
    header: 'Coverage',
    priority: 'primary',
    render: (item) => (
      <>
        {formatPercentage(item.coverage)}
        {item.qualityStatus === 'unknown' && (
          <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            low coverage
          </span>
        )}
      </>
    ),
  },
  {
    key: 'evaluatedCount',
    header: 'Evaluated count',
    priority: 'secondary',
    render: (item) => item.evaluatedCount,
  },
  {
    key: 'prevalence',
    header: 'Prevalence',
    priority: 'secondary',
    render: (item) => formatPercentage(item.prevalence),
  },
  {
    key: 'quality',
    header: 'Quality',
    priority: 'secondary',
    render: (item) => item.qualityStatus,
  },
  {
    key: 'findings',
    header: 'Findings',
    priority: 'secondary',
    render: (item) =>
      item.activeFindingCount > 0
        ? `${item.activeFindingCount} (${item.highestFindingSeverity ?? 'unknown'})`
        : '—',
  },
]

/**
 * 旧 Labels 一覧画面。`isNewUiSectionEnabled('labels')` が無効な間はこちらを表示する。
 * 新実装は {@link NewLabelsView} を参照。
 * @returns ラベル一覧ページの描画結果
 */
async function LegacyLabelsPage(): Promise<React.ReactElement> {
  let snapshot: Awaited<ReturnType<typeof getLabelAggregateSnapshot>>
  try {
    snapshot = await getLabelAggregateSnapshot(getPrismaClient())
  } catch (error) {
    // error.message には SQL 接続情報などドライバー由来の詳細が含まれうるため、
    // 詳細はサーバー側のログにのみ残し、クライアントには一般的なメッセージだけを返す。
    console.error('Failed to load label definitions:', error)
    return <ErrorFallback message="Failed to load label definitions." />
  }

  const { distribution: entries, lastSuccessAt, lastAttemptStatus } = snapshot

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Labels</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Last aggregated: {lastSuccessAt ? formatDateTime(lastSuccessAt) : '—'}
        </p>
      </div>
      {lastAttemptStatus === 'failed' && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          {lastSuccessAt
            ? '最新の集計に失敗しました。表示中の値は前回成功時点のものです。'
            : '最新の集計に失敗しました。まだ一度も集計が成功していないため、ラベル分布は表示できません。'}
        </div>
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No labels are registered yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <ResponsiveTable
            columns={legacyLabelColumns}
            rows={entries}
            rowKey={(entry) => entry.labelKey}
          />
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
    const { items, readiness } = await listLabelSummaries(prisma)

    if (readiness !== 'ready') {
      return (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Labels</h1>
          <ReadModelReadinessPanel status={readiness} section="Labels" />
        </div>
      )
    }

    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">Labels</h1>
        {items.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No labels to show yet.</p>
        ) : (
          <ResponsiveTable
            columns={newLabelColumns}
            rows={items}
            rowKey={(item) => item.labelDefinitionId}
          />
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
