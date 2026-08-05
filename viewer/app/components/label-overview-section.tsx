import React from 'react'
import Link from 'next/link'
import { LabelDistributionChart } from './label-distribution-chart'
import type { LabelDistributionEntry } from '../../lib/queries/dashboard'

export function LabelOverviewSection({
  entries,
}: {
  entries: LabelDistributionEntry[]
}): React.JSX.Element {
  return (
    <section>
      <h2 className="text-lg font-semibold">Label overview</h2>
      <LabelDistributionChart entries={entries} />
      <Link href="/labels" className="mt-2 inline-block text-sm text-blue-600 underline">
        View full label distribution
      </Link>
    </section>
  )
}
