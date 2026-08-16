import React from 'react'
import Link from 'next/link'
import { formatPercentage } from '@/lib/format-percentage'
import { getPrismaClient } from '@/lib/prisma'
import { listLabelSummaries, type LabelSummaryListItem } from '@/lib/queries/label-summary'
import { ErrorFallback } from '../components/error-fallback'
import { ReadModelReadinessPanel } from '../components/read-model-readiness-panel'
import { ResponsiveTable, type ResponsiveTableColumn } from '../components/responsive-table'

// 指定しないと、DB 接続がないビルド時に next build が静的生成を試みてしまう。
export const dynamic = 'force-dynamic'

const labelColumns: ResponsiveTableColumn<LabelSummaryListItem>[] = [
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
 * Labels 一覧画面。label_summary read model (`LabelSummaryCurrent`) を参照する。
 * @returns ラベル一覧画面の描画結果
 */
export default async function LabelsPage(): Promise<React.ReactElement> {
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
            columns={labelColumns}
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
