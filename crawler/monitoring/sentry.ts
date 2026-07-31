import * as Sentry from '@sentry/node'

let initialized = false

// GLITCHTIP_DSN is only configured in the production compose file and is expected to be
// unset for local development runs, so a missing DSN is a deliberate no-op rather than a
// throw - unlike COOKIE_ISSUER_URL, monitoring must never block a run.
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
