import { Logger } from '@book000/node-utils'
import * as Sentry from '@sentry/node'

const logger = Logger.configure('monitoring/sentry')

let initialized = false

// GLITCHTIP_DSN はローカル開発では未設定になり得るため、
// COOKIE_ISSUER_URL とは異なり、
// 未設定時に throw はせず意図的に no-op にしている。
// 監視処理がブロック実行そのものを止めてはならないため。
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

/**
 * 例外以外のイベントを GlitchTip に報告する。initMonitoring 未実行時は何もせず戻る。
 * captureException と同様、送信失敗で throw すると呼び出し元の処理を止めてしまうため、
 * その場合のみ例外を投げずログ出力に留める。
 * @param message - 報告する概要テキスト
 * @param context - イベントの `extra` として付与する追加の構造化データ
 */
export function captureMessage(message: string, context?: Record<string, unknown>): void {
  if (!initialized) return
  try {
    Sentry.captureMessage(message, { level: 'warning', extra: context })
  } catch (reportError) {
    logger.warn('Failed to report message to GlitchTip', reportError as Error)
  }
}
