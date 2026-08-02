import { Logger } from '@book000/node-utils'
import * as Sentry from '@sentry/node'

const logger = Logger.configure('monitoring/sentry')

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
  // Reporting to GlitchTip is best-effort: per the module-level invariant above, a throw
  // here must never propagate into the caller's own error handling.
  try {
    Sentry.captureException(error, context)
  } catch (reportError) {
    logger.warn('Failed to report exception to GlitchTip', reportError as Error)
  }
}

/**
 * Reports a non-exception event (e.g. an aggregated warning-count summary) to GlitchTip.
 * Mirrors captureException's initialized-guard and never-throw guarantee: a no-op when
 * GLITCHTIP_DSN is unset, and any failure to report is logged rather than propagated.
 * @param message - the summary text to report
 * @param context - additional structured data attached as the event's `extra` payload
 */
export function captureMessage(message: string, context?: Record<string, unknown>): void {
  if (!initialized) return
  try {
    Sentry.captureMessage(message, { level: 'warning', extra: context })
  } catch (reportError) {
    logger.warn('Failed to report message to GlitchTip', reportError as Error)
  }
}
