/**
 * @returns Cookie Issuer サービスのベース URL
 * @throws `COOKIE_ISSUER_URL` が未設定の場合。
 */
export function getCookieIssuerBaseUrl(): string {
  const value = process.env.COOKIE_ISSUER_URL
  if (!value) {
    throw new Error('COOKIE_ISSUER_URL environment variable is required')
  }
  return value
}

/**
 * 環境変数を正の整数として読み取る。未設定・空文字ならデフォルト値を返す。
 * `Number()` は16進数・指数表記・符号付き文字列なども受理してしまうため、
 * 10進数の数字列のみを許可する正規表現で事前に絞り込む。
 * @param name - 環境変数名
 * @param defaultValue - 未設定・空文字時のデフォルト値
 * @returns 読み取った正の整数
 */
function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} environment variable must be a positive integer`)
  }
  return Number(raw)
}

/**
 * ブロック実行サイクルの間隔 (秒)。crawler の CRAWL_INTERVAL_SECONDS とは独立した値であり、
 * 揃える必要はないため別の環境変数として読む。
 * @returns ブロック実行間隔 (秒)
 */
export function getBlockIntervalSeconds(): number {
  return parsePositiveIntEnv('BLOCK_INTERVAL_SECONDS', 21_600)
}

/**
 * 1件ブロックするごとの待機時間 (ミリ秒)。crawler の authorFetchDelayMs (300ms) より長くし、
 * 自動操作としての検知リスクを抑えるためデフォルトを大きく設定している。
 * @returns ブロック実行の待機時間 (ミリ秒)
 */
export function getBlockActionDelayMs(): number {
  return parsePositiveIntEnv('BLOCK_ACTION_DELAY_MS', 2000)
}

/**
 * 1アカウント・1サイクルあたりのブロック上限件数。ルール設定の誤りで大量ブロックが
 * 暴走するのを防ぐ安全弁として、超過分は次回以降のサイクルに回す前提の値。
 * @returns アカウントごとのブロック上限件数
 */
export function getBlockMaxPerAccountPerRun(): number {
  return parsePositiveIntEnv('BLOCK_MAX_PER_ACCOUNT_PER_RUN', 50)
}
