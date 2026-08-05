import React from 'react'
import Link from 'next/link'
import { LabelDistributionChart } from './label-distribution-chart'
import { LoadingStatus, Skeleton } from './skeleton'
import type { LabelDistributionEntry } from '../../lib/queries/dashboard'

/**
 * グラフ本体と凡例リストの高さを模した読み込み中プレースホルダー。
 * @returns 描画されたラベル概要セクションの読み込み表示
 */
export function LabelOverviewSkeleton(): React.ReactElement {
  return (
    <section>
      <h2 className="text-lg font-semibold">Label overview</h2>
      <LoadingStatus label="label overview" />
      <div className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <Skeleton className="h-48 w-full" />
        <div className="mt-4 flex flex-wrap gap-3">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-4 w-24" />
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * @param props - 上位ラベルの陽性数・評価対象数一覧
 * @returns 描画されたラベル概要セクション
 */
export function LabelOverviewSection({
  entries,
}: {
  entries: LabelDistributionEntry[]
}): React.JSX.Element {
  return (
    <section>
      <h2 className="text-lg font-semibold">Label overview</h2>
      <LabelDistributionChart entries={entries} />
      <Link
        href="/labels"
        className="mt-2 inline-block text-sm text-blue-600 underline dark:text-blue-400"
      >
        View full label distribution
      </Link>
    </section>
  )
}
