import React from 'react'
import Link from 'next/link'
import { getPrismaClient } from '@/lib/prisma'
import { listOperationCycles, type OperationCycleKind } from '@/lib/queries/operation-cycles'
import { formatDateTime } from '@/lib/format-date'
import { formatDuration } from '@/lib/format-duration'
import { ErrorFallback } from '../components/error-fallback'
import { CursorPagination } from '../components/cursor-pagination'
import { notFound } from 'next/navigation'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'

export const dynamic = 'force-dynamic'

const KIND_TO_PATH: Record<string, string> = {
  crawl: 'crawl',
  weekly_review: 'review',
  block: 'block',
}

const VALID_KINDS: OperationCycleKind[] = ['crawl', 'weekly_review', 'block']

const KIND_LABEL: Record<string, string> = {
  crawl: 'Crawl',
  weekly_review: 'Weekly review',
  block: 'Block',
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  running: 'Running',
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
  delayed: 'Delayed',
  stale: 'Stale',
  cancelled: 'Cancelled',
  unknown: 'Unknown',
}

function stageLabel(stageKey: string | null): string {
  if (!stageKey) return '—'
  const labels: Record<string, string> = {
    crawl: 'Crawl',
    label_metrics: 'Label metrics',
    finding_generation: 'Finding generation',
    read_model_refresh: 'Read model refresh',
    weekly_review: 'Weekly review',
    block: 'Block',
    block_reconciliation: 'Block reconciliation',
  }
  return labels[stageKey] ?? stageKey.replaceAll('_', ' ')
}

interface OperationsPageProps {
  searchParams: Promise<{ kind?: string; attentionRequired?: string; cursor?: string }>
}

/**
 * Operations 一覧画面。
 * @param props - `kind`/`attentionRequired`/`cursor` 検索パラメータ
 * @returns 描画された Operations 一覧画面
 */
export default async function OperationsPage({
  searchParams,
}: OperationsPageProps): Promise<React.ReactElement> {
  if (!isNewUiSectionEnabled('operations')) notFound()

  const params = await searchParams
  const kind = (VALID_KINDS as string[]).includes(params.kind ?? '')
    ? (params.kind as OperationCycleKind)
    : undefined
  const attentionRequired = params.attentionRequired === 'true'

  const prisma = getPrismaClient()
  try {
    const { items: cycles, nextCursor } = await listOperationCycles(prisma, {
      filters: { kind, attentionRequired },
      cursor: params.cursor,
    })

    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Operations</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Execution history for crawl, analysis, read-model refresh, review, and block pipelines.
          </p>
        </div>
        {cycles.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No cycles to show yet.</p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-gray-100 dark:bg-gray-700">
              <tr>
                <th className="p-3">Operation</th>
                <th className="p-3">Status</th>
                <th className="p-3">Current stage</th>
                <th className="p-3">Started</th>
                <th className="p-3">Finished</th>
                <th className="p-3">Duration</th>
                <th className="p-3">Attention</th>
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
                      {KIND_LABEL[cycle.kind] ?? cycle.kind}
                    </Link>
                  </td>
                  <td className="p-3">{STATUS_LABEL[cycle.status] ?? cycle.status}</td>
                  <td className="p-3">{stageLabel(cycle.currentStageKey)}</td>
                  <td className="p-3">{cycle.startedAt ? formatDateTime(cycle.startedAt) : '—'}</td>
                  <td className="p-3">
                    {cycle.finishedAt ? formatDateTime(cycle.finishedAt) : 'In progress'}
                  </td>
                  <td className="p-3">
                    {cycle.startedAt && cycle.finishedAt
                      ? formatDuration(cycle.startedAt, cycle.finishedAt)
                      : '—'}
                  </td>
                  <td className="p-3">{cycle.attentionRequired ? 'Required' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CursorPagination basePath="/operations" currentParams={params} nextCursor={nextCursor} />
      </div>
    )
  } catch (error) {
    console.error('Failed to load operation cycles:', error)
    return <ErrorFallback message="Failed to load the operation cycles." />
  }
}
