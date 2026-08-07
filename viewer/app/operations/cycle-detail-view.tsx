import type { OperationCycleDetailView } from '@/lib/queries/operation-cycles'
import { formatDateTime } from '@/lib/format-date'

/**
 * crawl/weekly_review/block の 3 種類の Cycle 詳細ページで共通の
 * Stage timeline 描画を提供する。spec の情報階層 (Cycle 概要→Stage timeline) に従う。
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
                  <td className="p-2">{stage.status}</td>
                  <td className="p-2">{stage.startedAt ? formatDateTime(stage.startedAt) : '—'}</td>
                  <td className="p-2">
                    {stage.finishedAt ? formatDateTime(stage.finishedAt) : '—'}
                  </td>
                  <td className="p-2">{stage.errorSummary ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
