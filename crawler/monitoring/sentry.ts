import { Logger } from '@book000/node-utils'
import * as Sentry from '@sentry/node'

const logger = Logger.configure('monitoring/sentry')

let initialized = false

// GLITCHTIP_DSN はローカル開発では未設定になり得るため、
// COOKIE_ISSUER_URL とは異なり、
// 未設定時に throw はせず意図的に no-op にしている。
// 監視処理がクロール実行そのものを止めてはならないため。
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

/**
 * 例外以外のイベントを GlitchTip に報告する。initMonitoring 未実行時は何もせず戻る。
 * captureException と同様、送信失敗で throw すると呼び出し元の処理を止めてしまうため、
 * その場合のみ例外を投げずログ出力に留める。
 * @param message - 報告する概要テキスト
 * @param context - イベントの `extra` として付与する追加の構造化データ
 * @param grouping - grouping (fingerprint) とタグ付けのための追加オプション
 */
export function captureMessage(
  message: string,
  context?: Record<string, unknown>,
  grouping?: CaptureGroupingOptions,
): void {
  if (!initialized) return
  try {
    Sentry.captureMessage(message, {
      level: 'warning',
      extra: context,
      fingerprint: grouping?.fingerprint,
      tags: grouping?.tags,
    })
  } catch (reportError) {
    logger.warn('Failed to report message to GlitchTip', reportError as Error)
  }
}
