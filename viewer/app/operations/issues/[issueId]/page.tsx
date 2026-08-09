import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPrismaClient } from '@/lib/prisma'
import { getOperationalIssueDetail } from '@/lib/queries/operational-issue-detail'
import { formatDateTime } from '@/lib/format-date'
import { ErrorFallback } from '../../../components/error-fallback'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'

interface OperationalIssueDetailPageProps {
  params: Promise<{ issueId: string }>
}

const KIND_TO_PATH: Record<string, string> = {
  crawl: 'crawl',
  weekly_review: 'review',
  block: 'block',
}

/**
 * OperationalIssue 詳細画面。Attention Queue の detailHref の遷移先。
 * @param props - Next.js の dynamic route params
 * @returns 描画された OperationalIssue 詳細画面
 */
export default async function OperationalIssueDetailPage({
  params,
}: OperationalIssueDetailPageProps): Promise<React.ReactElement> {
  if (!isNewUiSectionEnabled('operations')) notFound()

  const { issueId } = await params
  const prisma = getPrismaClient()

  const detail = await (async () => {
    try {
      return await getOperationalIssueDetail(prisma, issueId)
    } catch (error) {
      console.error('Failed to load the operational issue detail:', error)
      return undefined
    }
  })()

  if (detail === undefined) {
    return <ErrorFallback message="Failed to load the operational issue detail." />
  }
  if (!detail) notFound()

  const sourceCyclePath = detail.sourceCycleKind ? KIND_TO_PATH[detail.sourceCycleKind] : undefined

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">
        {detail.component}: {detail.type}
      </h1>

      <section aria-labelledby="conclusion-heading">
        <h2 id="conclusion-heading" className="text-lg font-semibold">
          Conclusion
        </h2>
        <p className="mt-2">
          {detail.severity} severity, {detail.status}
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
        {detail.sourceCycleId && sourceCyclePath && (
          <p className="mt-2">
            <Link
              href={`/operations/${sourceCyclePath}/${detail.sourceCycleId}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Source cycle
            </Link>
          </p>
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
                <th className="p-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {detail.occurrences.map((occurrence) => (
                <tr key={occurrence.id} className="border-t dark:border-gray-700">
                  <td className="p-2">{formatDateTime(occurrence.observedAt)}</td>
                  <td className="p-2">{occurrence.stateTransition}</td>
                  <td className="p-2">{occurrence.severity}</td>
                  <td className="p-2 font-mono text-xs">
                    {occurrence.sourceType}:{occurrence.sourceId}
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
