import { Logger } from '@book000/node-utils'
import * as Sentry from '@sentry/node'

const logger = Logger.configure('monitoring/sentry')

let initialized = false

// GLITCHTIP_DSN はローカル開発では未設定になり得るため、
// COOKIE_ISSUER_URL とは異なり、
// 未設定時に throw はせず意図的に no-op にしている。
// 監視処理が analyzer の実行そのものを止めてはならないため。
export function initMonitoring(): void {
  const dsn = process.env.GLITCHTIP_DSN
  if (!dsn) return
  Sentry.init({ dsn })
  initialized = true
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return
  // GlitchTip への報告はベストエフォートであり、
  // ここでの throw を呼び出し元のエラーハンドリングに伝播させてはならない。
  try {
    Sentry.captureException(error, context)
  } catch (reportError) {
    logger.warn('Failed to report exception to GlitchTip', reportError as Error)
  }
}
