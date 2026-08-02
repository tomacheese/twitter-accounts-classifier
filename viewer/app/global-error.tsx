'use client'

/**
 * Root error boundary for failures that escape the root layout itself
 * (`error.tsx` only catches errors thrown by its siblings/children, not by
 * `layout.tsx`). Must render its own `<html>`/`<body>` since it replaces
 * the root layout when triggered.
 * @param props - the caught error and a function to retry rendering
 * @returns the rendered error page
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.ReactElement {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-16 text-center text-gray-900 dark:bg-gray-900 dark:text-gray-100">
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
      </body>
    </html>
  )
}
