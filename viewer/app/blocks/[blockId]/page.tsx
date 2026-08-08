import React from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPrismaClient } from '@/lib/prisma'
import { getBlockRelationDetail } from '@/lib/queries/block-relations'
import { formatDateTime } from '@/lib/format-date'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import { ErrorFallback } from '../../components/error-fallback'

interface BlockDetailPageProps {
  params: Promise<{ blockId: string }>
}

/**
 * Block 関係詳細画面。
 * @param props - Next.js の dynamic route params
 * @returns 描画された Block 関係詳細画面
 */
export default async function BlockDetailPage({
  params,
}: BlockDetailPageProps): Promise<React.ReactElement> {
  if (!isNewUiSectionEnabled('blocks')) notFound()

  const { blockId } = await params
  const prisma = getPrismaClient()

  const detail = await (async () => {
    try {
      return await getBlockRelationDetail(prisma, blockId)
    } catch (error) {
      console.error('Failed to load the block relation detail:', error)
      return undefined
    }
  })()

  if (detail === undefined) {
    return <ErrorFallback message="Failed to load the block relation detail." />
  }
  if (!detail) notFound()

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">
        {detail.blocker.screenName} → {detail.blocked.screenName}
      </h1>

      <section aria-labelledby="current-relationship-heading">
        <h2 id="current-relationship-heading" className="text-lg font-semibold">
          Current relationship
        </h2>
        <p className="mt-2">Status: {detail.status}</p>
      </section>

      <section aria-labelledby="accounts-heading">
        <h2 id="accounts-heading" className="text-lg font-semibold">
          Accounts
        </h2>
        <ul className="mt-2 flex flex-col gap-1">
          <li>
            Blocker:{' '}
            <Link
              href={`/accounts/${detail.blocker.id}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {detail.blocker.screenName} ({detail.blocker.displayName})
            </Link>
          </li>
          <li>
            Blocked:{' '}
            <Link
              href={`/accounts/${detail.blocked.id}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {detail.blocked.screenName} ({detail.blocked.displayName})
            </Link>
          </li>
        </ul>
      </section>

      <section aria-labelledby="observation-summary-heading">
        <h2 id="observation-summary-heading" className="text-lg font-semibold">
          Observation summary
        </h2>
        <p className="mt-2">
          First seen {formatDateTime(detail.firstSeenAt)}, last seen{' '}
          {formatDateTime(detail.lastSeenAt)}, last checked {formatDateTime(detail.lastCheckedAt)}.
        </p>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Consecutive missing count: {detail.consecutiveMissingCount}
          {detail.missingSinceAt ? `, missing since ${formatDateTime(detail.missingSinceAt)}` : ''}
          {detail.resolvedAt ? `, resolved ${formatDateTime(detail.resolvedAt)}` : ''}.
        </p>
      </section>

      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading" className="text-lg font-semibold">
          Timeline
        </h2>
        {detail.timeline.length === 0 ? (
          <p className="mt-2">No state changes recorded.</p>
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Changed at</th>
                <th className="p-2">From</th>
                <th className="p-2">To</th>
              </tr>
            </thead>
            <tbody>
              {detail.timeline.map((change) => (
                <tr key={change.id} className="border-t dark:border-gray-700">
                  <td className="p-2">{formatDateTime(change.changedAt)}</td>
                  <td className="p-2">{change.fromStatus ?? '—'}</td>
                  <td className="p-2">{change.toStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="related-findings-heading">
        <h2 id="related-findings-heading" className="text-lg font-semibold">
          Related Label/Finding
        </h2>
        {detail.relatedFindings.length === 0 ? (
          <p className="mt-2">No related findings.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {detail.relatedFindings.map((finding) => (
              <li key={finding.id}>
                <Link
                  href={`/review/findings/${finding.id}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  {finding.type}
                </Link>{' '}
                ({finding.currentSeverity}, {finding.status})
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="technical-heading">
        <h2 id="technical-heading" className="text-lg font-semibold">
          Technical
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Block ID: {detail.id}, source kind: {detail.sourceKind}
        </p>
      </section>
    </div>
  )
}
