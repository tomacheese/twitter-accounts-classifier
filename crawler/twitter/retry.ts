/** HTTP status codes worth retrying: rate limiting and transient server-side failures. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

/**
 * Decides whether an error surfaced by `twitter-openapi-typescript`/`cycletls` is worth
 * retrying. Duck-typed on `.name` rather than `instanceof` against the generated client's
 * error classes (`ResponseError`, `FetchError`) to avoid depending on their exact export
 * path; both classes are documented as always setting that name.
 *
 * `ResponseError` (an HTTP response came back, but not 2xx) is retryable only for rate
 * limiting and server-side failures — a 4xx like 401/404 signals a real problem (bad auth,
 * suspended account) that retrying cannot fix. `FetchError` (the request itself failed
 * before any response, e.g. cycletls TLS handshake reset) is always retryable, since it
 * carries no status to inspect and network blips are exactly what a retry is for.
 * @param error - the error thrown by a Twitter API call
 * @returns true if retrying the same call again is worth attempting
 */
export function isRetryableTwitterError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'FetchError') return true
  if (error.name === 'ResponseError') {
    const status = (error as { response?: { status?: unknown } }).response?.status
    return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status)
  }
  return false
}

export interface RetryOptions {
  maxAttempts?: number
  delayMs?: number
  sleepImpl?: (ms: number) => Promise<void>
}

/**
 * Runs `fn`, retrying with linear backoff (`delayMs * attempt`) while
 * {@link isRetryableTwitterError} judges the failure transient. An error that is not
 * retryable, or the last attempt's error, is rethrown immediately.
 * @param fn - the Twitter API call to run
 * @param options - retry tuning: `maxAttempts` (default 3), `delayMs` (default 1000), and an
 * injectable `sleepImpl` for tests
 * @returns the resolved value of `fn`
 */
export async function withTwitterRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const delayMs = options.delayMs ?? 1000
  const sleepImpl =
    options.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isRetryableTwitterError(error) || attempt === maxAttempts) {
        throw error
      }
      await sleepImpl(delayMs * attempt)
    }
  }

  throw lastError
}
