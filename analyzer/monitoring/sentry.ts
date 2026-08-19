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

/** grouping (fingerprint) とタグ付けのための追加オプション。 */
export interface CaptureGroupingOptions {
  /**
   * 低 cardinality な識別子の配列。指定すると例外クラス+スタックトレースによる
   * デフォルトの grouping を上書きし、この値で GlitchTip の issue を分離する。
   */
  fingerprint?: string[]
  /** 検索・フィルタ用の低 cardinality なタグ。動的値や機密情報を含めないこと。 */
  tags?: Record<string, string | number | boolean>
}

export function captureException(
  error: unknown,
  context?: Record<string, unknown>,
  grouping?: CaptureGroupingOptions,
): void {
  if (!initialized) return
  // GlitchTip への報告はベストエフォートであり、
  // ここでの throw を呼び出し元のエラーハンドリングに伝播させてはならない。
  try {
    Sentry.captureException(error, {
      extra: context,
      fingerprint: grouping?.fingerprint,
      tags: grouping?.tags,
    })
  } catch (reportError) {
    logger.warn('Failed to report exception to GlitchTip', reportError as Error)
  }
}
