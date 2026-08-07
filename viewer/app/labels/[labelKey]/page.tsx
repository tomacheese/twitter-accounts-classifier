import { notFound } from 'next/navigation'
import { getPrismaClient } from '@/lib/prisma'
import { getLabelDetail, type LabelDetailRangePreset } from '@/lib/queries/label-detail'
import { formatDateTime } from '@/lib/format-date'
import { ErrorFallback } from '../../components/error-fallback'

interface LabelDetailPageProps {
  params: Promise<{ labelKey: string }>
  searchParams: Promise<{ range?: string }>
}

const RANGE_PRESETS: LabelDetailRangePreset[] = ['24h', '7d', '30d', '90d']

/**
 * @param value - 生の検索パラメータの値
 * @returns サポートされている期間 preset であれば true
 */
function isRangePreset(value: string | undefined): value is LabelDetailRangePreset {
  return !!value && (RANGE_PRESETS as string[]).includes(value)
}

/**
 * Label 詳細画面。
 * @param props - Next.js の dynamic route params と `range` 検索パラメータ
 * @returns 描画された Label 詳細画面
 */
export default async function LabelDetailPage({
  params,
  searchParams,
}: LabelDetailPageProps): Promise<React.ReactElement> {
  const { labelKey } = await params
  const { range: rawRange } = await searchParams
  const range = isRangePreset(rawRange) ? rawRange : '30d'

  const prisma = getPrismaClient()

  const detail = await (async () => {
    try {
      return await getLabelDetail(prisma, labelKey, { range })
    } catch (error) {
      console.error('Failed to load the label detail:', error)
      return undefined
    }
  })()

  if (detail === undefined) {
    return <ErrorFallback message="Failed to load the label detail." />
  }
  if (!detail) notFound()

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold font-mono">{detail.labelKey}</h1>
      <p className="text-sm text-gray-600 dark:text-gray-400">{detail.description}</p>

      <section aria-labelledby="current-metrics-heading">
        <h2 id="current-metrics-heading" className="text-lg font-semibold">
          Current metrics
        </h2>
        {detail.latestSnapshot ? (
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <dt>Prevalence</dt>
            <dd>{(detail.latestSnapshot.prevalence * 100).toFixed(1)}%</dd>
            <dt>Evaluated</dt>
            <dd>{detail.latestSnapshot.evaluatedCount.toLocaleString()}</dd>
            <dt>True</dt>
            <dd>{detail.latestSnapshot.trueCount.toLocaleString()}</dd>
            <dt>Observed at</dt>
            <dd>{formatDateTime(detail.latestSnapshot.observedAt)}</dd>
          </dl>
        ) : (
          <p className="mt-2">No snapshot recorded yet.</p>
        )}
      </section>

      <section aria-labelledby="trend-heading">
        <h2 id="trend-heading" className="text-lg font-semibold">
          Trend ({range})
        </h2>
        {detail.trend.length === 0 ? (
          <p className="mt-2">No trend data for this range.</p>
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Date</th>
                <th className="p-2">Prevalence</th>
              </tr>
            </thead>
            <tbody>
              {detail.trend.map((point) => (
                <tr key={point.date.toISOString()} className="border-t">
                  <td className="p-2">{point.date.toISOString().slice(0, 10)}</td>
                  <td className="p-2">{(point.prevalence * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="findings-heading">
        <h2 id="findings-heading" className="text-lg font-semibold">
          Findings
        </h2>
        {detail.activeFindings.length === 0 ? (
          <p className="mt-2">No active findings.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {detail.activeFindings.map((finding) => (
              <li key={finding.findingId}>
                [{finding.currentSeverity}] {finding.type}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
