import { notFound } from 'next/navigation'
import { getPrismaClient } from '@/lib/prisma'
import { getReviewFindingDetail } from '@/lib/queries/review-finding-detail'
import { formatDateTime } from '@/lib/format-date'
import { ErrorFallback } from '../../../components/error-fallback'

interface FindingDetailPageProps {
  params: Promise<{ findingId: string }>
}

/**
 * Finding 詳細画面。spec の情報階層 (Conclusion→Impact→Detection Basis→Evidence→
 * Occurrence History) のうち固定の情報階層で表示し、Occurrence 追加分・Raw Analysis は
 * `/api/review/findings/[findingId]/occurrences` から Client Component で遅延取得する
 * 想定だが、本タスクでは初期表示に必要な直近 10 件の Occurrence までを Server Component で描画する。
 * @param props - Next.js の dynamic route params
 * @returns 描画された Finding 詳細画面
 */
export default async function FindingDetailPage({
  params,
}: FindingDetailPageProps): Promise<React.ReactElement> {
  const { findingId } = await params
  const prisma = getPrismaClient()

  const detail = await (async () => {
    try {
      return await getReviewFindingDetail(prisma, findingId)
    } catch (error) {
      console.error('Failed to load the finding detail:', error)
      return undefined
    }
  })()

  if (detail === undefined) {
    return <ErrorFallback message="Failed to load the finding detail." />
  }
  if (!detail) notFound()

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{detail.type}</h1>

      <section aria-labelledby="conclusion-heading">
        <h2 id="conclusion-heading" className="text-lg font-semibold">
          Conclusion
        </h2>
        <p className="mt-2">
          {detail.currentSeverity} severity, {detail.status} (max: {detail.maximumSeverity})
        </p>
      </section>

      <section aria-labelledby="impact-heading">
        <h2 id="impact-heading" className="text-lg font-semibold">
          Impact
        </h2>
        <p className="mt-2">
          Scope: {detail.primaryScopeType}:{detail.primaryScopeId}. Recurred{' '}
          {detail.recurrenceCount} time(s).
        </p>
      </section>

      <section aria-labelledby="detection-basis-heading">
        <h2 id="detection-basis-heading" className="text-lg font-semibold">
          Detection Basis
        </h2>
        <p className="mt-2">
          First detected {formatDateTime(detail.firstDetectedAt)}, last detected{' '}
          {formatDateTime(detail.lastDetectedAt)}
          {detail.resolvedAt ? `, resolved ${formatDateTime(detail.resolvedAt)}` : ''}.
        </p>
      </section>

      <section aria-labelledby="evidence-heading">
        <h2 id="evidence-heading" className="text-lg font-semibold">
          Evidence
        </h2>
        {detail.evidences.length === 0 ? (
          <p className="mt-2">No evidence recorded.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {detail.evidences.map((evidence) => (
              <li key={evidence.id}>
                {evidence.kind} ({formatDateTime(evidence.createdAt)})
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="occurrence-history-heading">
        <h2 id="occurrence-history-heading" className="text-lg font-semibold">
          Occurrence History
        </h2>
        {detail.occurrences.length === 0 ? (
          <p className="mt-2">No occurrences recorded.</p>
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Observed at</th>
                <th className="p-2">Transition</th>
                <th className="p-2">Severity</th>
                <th className="p-2">Affected ratio</th>
              </tr>
            </thead>
            <tbody>
              {detail.occurrences.map((occurrence) => (
                <tr key={occurrence.id} className="border-t">
                  <td className="p-2">{formatDateTime(occurrence.observedAt)}</td>
                  <td className="p-2">{occurrence.stateTransition}</td>
                  <td className="p-2">{occurrence.severity}</td>
                  <td className="p-2">{occurrence.affectedRatio ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
