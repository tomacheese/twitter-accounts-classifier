import React from 'react'
import type { OperationCycleDetailView, OperationStageView } from '@/lib/queries/operation-cycles'
import { formatDateTime } from '@/lib/format-date'
import { ResponsiveTable, type ResponsiveTableColumn } from '../components/responsive-table'

/** label_aggregate_refresh Stage の errorCode ごとの表示ラベル。 */
const LABEL_AGGREGATE_ERROR_LABEL: Record<string, string> = {
  label_aggregate_snapshot_failed: 'Snapshot aggregation failed',
  label_finding_generation_failed: 'Finding generation failed',
  label_summary_publish_failed: 'Read model publish failed',
}

const STAGE_STATUS_LABEL: Record<string, { label: string; className: string }> = {
  blocked_by_upstream: {
    label: 'Blocked (upstream failure)',
    className: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  },
}

/**
 * blocked_by_upstream を failed（root cause）と異なる色・注記で表示し、1 件の根本原因が Stage 数分の failed に見える事態を避ける。
 * @param status - Stage の状態
 * @returns 表示用のラベルと色クラス
 */
function stageStatusBadge(status: string): { label: string; className: string } {
  return STAGE_STATUS_LABEL[status] ?? { label: status, className: '' }
}

const stageColumns: ResponsiveTableColumn<OperationStageView>[] = [
  {
    key: 'stage',
    header: 'Stage',
    priority: 'primary',
    render: (stage) => stage.stageKey,
  },
  {
    key: 'status',
    header: 'Status',
    priority: 'primary',
    render: (stage) => (
      <span className={`rounded px-2 py-0.5 ${stageStatusBadge(stage.status).className}`}>
        {stageStatusBadge(stage.status).label}
      </span>
    ),
  },
  {
    key: 'requiredness',
    header: 'Requiredness',
    priority: 'secondary',
    render: (stage) => stage.requiredness,
  },
  {
    key: 'startedAt',
    header: 'Started at',
    priority: 'secondary',
    render: (stage) => (stage.startedAt ? formatDateTime(stage.startedAt) : '—'),
  },
  {
    key: 'finishedAt',
    header: 'Finished at',
    priority: 'secondary',
    render: (stage) => (stage.finishedAt ? formatDateTime(stage.finishedAt) : '—'),
  },
  {
    key: 'error',
    header: 'Error',
    priority: 'secondary',
    render: (stage) =>
      stage.errorCode
        ? (LABEL_AGGREGATE_ERROR_LABEL[stage.errorCode] ?? stage.errorCode)
        : (stage.errorSummary ?? '—'),
  },
]

/**
 * crawl/weekly_review/block の 3 種類の Cycle 詳細ページで共通の Stage timeline を描画する。
 * @param props - 表示する Cycle 詳細
 * @returns 描画された Cycle 詳細
 */
export function OperationCycleDetail({
  detail,
}: {
  detail: OperationCycleDetailView
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">
        {detail.kind} cycle: {detail.id}
      </h1>

      <section aria-labelledby="cycle-summary-heading">
        <h2 id="cycle-summary-heading" className="text-lg font-semibold">
          Summary
        </h2>
        <p className="mt-2">
          Status: {detail.status}
          {detail.attentionRequired ? ' (attention required)' : ''}
        </p>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Triggered {formatDateTime(detail.triggeredAt)}
          {detail.startedAt ? `, started ${formatDateTime(detail.startedAt)}` : ''}
          {detail.finishedAt ? `, finished ${formatDateTime(detail.finishedAt)}` : ''}
        </p>
      </section>

      <section aria-labelledby="stage-timeline-heading">
        <h2 id="stage-timeline-heading" className="text-lg font-semibold">
          Stage timeline
        </h2>
        {detail.stages.length === 0 ? (
          <p className="mt-2">No stages recorded.</p>
        ) : (
          <div className="mt-2">
            <ResponsiveTable
              columns={stageColumns}
              rows={detail.stages}
              rowKey={(stage) => stage.stageKey}
            />
          </div>
        )}
      </section>
    </div>
  )
}
