import { Logger } from '@book000/node-utils'

const logger = Logger.configure('config/env')

export function getCookieIssuerBaseUrl(): string {
  const value = process.env.COOKIE_ISSUER_URL
  if (!value) {
    throw new Error('COOKIE_ISSUER_URL environment variable is required')
  }
  return value
}

const DEFAULT_CRAWL_WARNING_THRESHOLD = 5

/**
 * Reads the per-account crawl-warning count threshold that triggers an aggregated
 * GlitchTip report (see crawl.ts's runAccountCycle). Unlike getCookieIssuerBaseUrl, this
 * value is optional operational tuning, not a hard requirement - an unset or unparsable
 * value falls back to a sane default instead of blocking the run.
 * @returns the configured threshold, or the default (5) if unset or invalid
 */
export function getCrawlWarningThreshold(): number {
  const raw = process.env.CRAWL_WARNING_THRESHOLD
  if (raw === undefined || raw === '') return DEFAULT_CRAWL_WARNING_THRESHOLD
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      `Invalid CRAWL_WARNING_THRESHOLD value "${raw}", falling back to default (${DEFAULT_CRAWL_WARNING_THRESHOLD})`,
    )
    return DEFAULT_CRAWL_WARNING_THRESHOLD
  }
  return parsed
}
