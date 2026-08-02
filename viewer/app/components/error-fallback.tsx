/**
 * Server-renderable error message shown when a page's own data fetch fails.
 * Preferred over the `error.tsx` boundary for caught failures: that boundary is
 * a Client Component and only paints after hydration, leaving the initial HTTP
 * response blank, whereas this renders into the very first response.
 * @param props - the message to display
 * @returns the rendered fallback
 */
export function ErrorFallback({ message }: { message: string }): React.ReactElement {
  return (
    <div
      aria-live="assertive"
      className="flex flex-col items-center gap-4 py-16 text-center"
      role="alert"
    >
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-gray-600 dark:text-gray-400">{message}</p>
    </div>
  )
}
