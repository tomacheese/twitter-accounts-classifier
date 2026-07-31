'use client'

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import Link from 'next/link'
import type { LabelDistributionEntry } from '@/lib/queries/dashboard'

const BAR_COLOR = '#2563eb'

/**
 * Renders a horizontal bar chart of how many accounts carry each label as
 * `true`, out of the accounts evaluated for it. Each bar links to the
 * account list pre-filtered to that label.
 * @param props - the label distribution entries to chart
 * @returns the rendered chart
 */
export function LabelDistributionChart({
  entries,
}: {
  entries: LabelDistributionEntry[]
}): React.ReactElement {
  const data = entries.map((entry) => ({
    label: entry.labelKey,
    trueCount: entry.trueCount,
    totalAccounts: entry.totalAccounts,
  }))

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <ResponsiveContainer width="100%" height={Math.max(200, entries.length * 40)}>
        <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis type="number" allowDecimals={false} />
          <YAxis type="category" dataKey="label" width={140} />
          <Tooltip />
          <Bar dataKey="trueCount" fill={BAR_COLOR} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <ul className="mt-4 flex flex-wrap gap-3 text-sm">
        {entries.map((entry) => {
          const percentage =
            entry.totalAccounts === 0
              ? 0
              : Math.round((entry.trueCount / entry.totalAccounts) * 100)
          return (
            <li key={entry.labelKey}>
              <Link
                href={`/accounts?label=${encodeURIComponent(entry.labelKey)}`}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {entry.labelKey}: {entry.trueCount}/{entry.totalAccounts} ({percentage}%)
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
