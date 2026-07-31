import * as Sentry from '@sentry/node'

let initialized = false

/**
 * Initializes error reporting, if a DSN is configured.
 *
 * `GLITCHTIP_DSN` is only set in the production compose file; local development
 * runs deliberately leave it unset. Unlike `COOKIE_ISSUER_URL`, monitoring must
 * never block a run, so a missing DSN is a silent no-op rather than an error.
 */
export function initMonitoring(): void {
  const dsn = process.env.GLITCHTIP_DSN
  if (!dsn) return
  Sentry.init({ dsn })
  initialized = true
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return
  Sentry.captureException(error, context)
}
