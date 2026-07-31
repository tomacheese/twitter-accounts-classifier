import Link from 'next/link'
import { getPrismaClient } from '@/lib/prisma'
import { getLabelDistribution, type LabelDistributionEntry } from '@/lib/queries/dashboard'
import { ErrorFallback } from '../components/error-fallback'

// This page always reads live data, so opt it out of static prerendering:
// without this, `next build` tries to statically generate it at build time,
// when no database connection is available.
export const dynamic = 'force-dynamic'

/**
 * Label reference page: every registered `LabelDefinition`, with its
 * `description` — the same human-readable text each rule module supplies
 * when it registers, describing exactly what condition sets that label to
 * `true` — plus how many currently-evaluated accounts carry it.
 * @returns the rendered label reference page
 */
export default async function LabelsPage(): Promise<React.ReactElement> {
  let entries: LabelDistributionEntry[]
  try {
    entries = await getLabelDistribution(getPrismaClient())
  } catch (error) {
    // Log the full error server-side but show the client a generic message:
    // error.message can leak SQL/connection details from the driver.
    console.error('Failed to load label definitions:', error)
    return <ErrorFallback message="Failed to load label definitions." />
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Labels</h1>
      {entries.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No labels are registered yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-100 text-left dark:bg-gray-700">
              <tr>
                <th className="p-3">Key</th>
                <th className="p-3">Condition</th>
                <th className="p-3">Accounts labeled true</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const percentage =
                  entry.totalAccounts === 0
                    ? 0
                    : Math.round((entry.trueCount / entry.totalAccounts) * 100)
                return (
                  <tr key={entry.labelKey} className="border-t align-top dark:border-gray-700">
                    <td className="p-3 font-mono">{entry.labelKey}</td>
                    <td className="p-3">{entry.labelDescription}</td>
                    <td className="p-3 whitespace-nowrap">
                      <Link
                        href={`/accounts?label=${encodeURIComponent(entry.labelKey)}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {entry.trueCount}/{entry.totalAccounts} ({percentage}%)
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
