/**
 * A single KPI stat tile: a label and a large value, used in a row across
 * the top of the dashboard.
 * @param props - the tile's label and value to display
 * @returns the rendered stat tile
 */
export function StatTile({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  )
}
