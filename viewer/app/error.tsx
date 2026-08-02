'use client'

/**
 * Segment-level error boundary for the viewer app. Rendered whenever a
 * page's data fetch throws (most commonly a database connection failure).
 * Distinct from `global-error.tsx`, which only fires for errors that escape
 * the root layout itself.
 * @param props - the caught error and a function to retry rendering
 * @returns the rendered error page
 */
export default function SegmentError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-gray-600 dark:text-gray-400" role="alert">
        The viewer could not load data. Please try again.
      </p>
      <button
        type="button"
        onClick={() => {
          reset()
        }}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white"
      >
        Retry
      </button>
    </div>
  )
}
