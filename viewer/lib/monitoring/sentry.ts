import * as Sentry from '@sentry/node'

let initialized = false

/**
 * DSN が設定されている場合のみ、エラー監視を初期化する。
 * `GLITCHTIP_DSN` は本番用の compose ファイルにのみ設定され、
 * ローカル開発では意図的に未設定のままにしている。
 * `COOKIE_ISSUER_URL` と異なり監視は実行を止めてはならないため、
 * DSN 未設定はエラーではなく無音のノーオペレーションとして扱う。
 */
export function initMonitoring(): void {
  const dsn = process.env.GLITCHTIP_DSN
  if (!dsn) return
  Sentry.init({ dsn })
  initialized = true
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return
  // context をそのまま渡すと Sentry の CaptureContext 判定にヒットせず、
  // 未知キーのオブジェクトとして黙って破棄されるため extra に包む。
  Sentry.captureException(error, { extra: context })
}
