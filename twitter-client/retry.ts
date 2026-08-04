/** リトライする価値がある HTTP ステータスコード: リクエストタイムアウト・レート制限・一時的なサーバー側障害。 */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

/**
 * `twitter-openapi-typescript`・`cycletls` が投げるエラーがリトライする価値があるかを判定する。
 * 生成クライアントのエラークラス (`ResponseError`・`FetchError`) の export パスに依存しないよう、
 * `instanceof` ではなく `.name` によるダックタイピングで判定している。
 * 両クラスとも常にこの `name` を設定することがドキュメントされている。
 *
 * `ResponseError` (2xx 以外のレスポンス時) はタイムアウト・レート制限・サーバー側障害のみリトライ対象とする。
 * 401/404 等 4xx は認証不備やアカウント停止などリトライで解決しない問題を示すため対象外にする。
 * `FetchError` (リクエスト自体が失敗。例: TLS ハンドシェイクリセット) はステータスを持たず、
 * ネットワークの一時的な不調こそリトライで対処すべきものであるため、
 * 常にリトライ対象としている。
 * @param error - Twitter API 呼び出しが投げたエラー
 * @returns 同じ呼び出しを再試行する価値があれば true
 */
export function isRetryableTwitterError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'FetchError') return true
  if (error.name === 'ResponseError') {
    const status = (error as { response?: { status?: unknown } }).response?.status
    return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status)
  }
  return false
}

export interface RetryOptions {
  maxAttempts?: number
  delayMs?: number
  sleepImpl?: (ms: number) => Promise<void>
}

/**
 * `maxAttempts` に達しても失敗した場合は、その最後のエラーをそのまま呼び出し側に投げ返す。
 * リトライを使い切ったことを示すための専用エラーには包み直さない。
 * @param fn - 実行する Twitter API 呼び出し
 * @param options - リトライ調整用。`maxAttempts`(既定 3)・`delayMs`(既定 1000)・注入用 `sleepImpl`
 * @returns `fn` の解決値
 */
export async function withTwitterRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const delayMs = options.delayMs ?? 1000
  const sleepImpl =
    options.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isRetryableTwitterError(error) || attempt === maxAttempts) {
        throw error
      }
      await sleepImpl(delayMs * attempt)
    }
  }

  throw lastError
}
