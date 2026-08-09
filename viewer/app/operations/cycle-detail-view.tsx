import React from 'react'
import type { OperationCycleDetailView } from '@/lib/queries/operation-cycles'
import { formatDateTime } from '@/lib/format-date'

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
 * blocked_by_upstream は直前 Stage の失敗による未実行であり、
 * failed（root cause）とは異なる色・注記で表示することで、
 * 1 件の根本原因が Stage 数分の failed に見える事態を避ける。
 * @param status - Stage の状態
 * @returns 表示用のラベルと色クラス
 */
function stageStatusBadge(status: string): { label: string; className: string } {
  return STAGE_STATUS_LABEL[status] ?? { label: status, className: '' }
}

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
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Stage</th>
                <th className="p-2">Requiredness</th>
                <th className="p-2">Status</th>
                <th className="p-2">Started at</th>
                <th className="p-2">Finished at</th>
                <th className="p-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {detail.stages.map((stage) => (
                <tr key={stage.stageKey} className="border-t dark:border-gray-700">
                  <td className="p-2">{stage.stageKey}</td>
                  <td className="p-2">{stage.requiredness}</td>
                  <td className="p-2">
                    <span
                      className={`rounded px-2 py-0.5 ${stageStatusBadge(stage.status).className}`}
                    >
                      {stageStatusBadge(stage.status).label}
                    </span>
                  </td>
                  <td className="p-2">{stage.startedAt ? formatDateTime(stage.startedAt) : '—'}</td>
                  <td className="p-2">
                    {stage.finishedAt ? formatDateTime(stage.finishedAt) : '—'}
                  </td>
                  <td className="p-2">
                    {stage.errorCode
                      ? (LABEL_AGGREGATE_ERROR_LABEL[stage.errorCode] ?? stage.errorCode)
                      : (stage.errorSummary ?? '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
