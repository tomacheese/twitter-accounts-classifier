export interface WeeklyAnalysisCompleteRetryOptions {
  maxAttempts?: number
  delayMs?: number
  sleep?: (delayMs: number) => Promise<void>
  onRetry?: (nextAttempt: number, maxAttempts: number) => void
}

const DEFAULT_MAX_ATTEMPTS = 61
const DEFAULT_DELAY_MS = 10_000

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isRetryableWeeklyAnalysisCompleteError(error: unknown): boolean {
  const code = errorCode(error)
  if (code === 'P1001' || code === 'P1017') return true

  const message = errorMessage(error).toLowerCase()
  return (
    message.includes('permission denied for table analysisworkitem') ||
    message.includes('database system is shutting down') ||
    message.includes("can't reach database server") ||
    message.includes('server has closed the connection') ||
    message.includes('connection refused') ||
    message.includes('econnrefused') ||
    message.includes('connection reset by peer')
  )
}

export async function retryWeeklyAnalysisComplete<T>(
  operation: () => Promise<T>,
  options: WeeklyAnalysisCompleteRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer')
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error('delayMs must be a non-negative finite number')
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isRetryableWeeklyAnalysisCompleteError(error) || attempt >= maxAttempts) throw error
      options.onRetry?.(attempt + 1, maxAttempts)
      await sleep(delayMs)
    }
  }
}
