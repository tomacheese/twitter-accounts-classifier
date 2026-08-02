export function getCookieIssuerBaseUrl(): string {
  const value = process.env.COOKIE_ISSUER_URL
  if (!value) {
    throw new Error('COOKIE_ISSUER_URL environment variable is required')
  }
  return value
}

/**
 * 環境変数を正の整数として読み取る。未設定・空文字ならデフォルト値を返す。`Number()` は
 * 16進数・指数表記・符号付き文字列なども受理してしまうため、10進数の数字列のみを許可する
 * 正規表現で事前に絞り込む。エラーメッセージには入力値そのものを含めない -
 * このヘルパーは汎用であり、将来 secret を扱う環境変数の検証に使われた場合に、
 * 生の値が GlitchTip 等のエラートラッキングへそのまま送られることを避けるため。
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
 * クロール間隔 (秒)。entrypoint.sh のサイクル間 sleep 時間と同じ環境変数を読み、
 * TypeScript 側でも放置判定のしきい値算出に利用する。未設定時は README 記載の
 * entrypoint.sh 側デフォルトと合わせて 21600 (6時間) とする。entrypoint.sh の
 * `sleep` はシェルの流儀で `6h` のような単位付き文字列も受理するが、こちらは
 * README が定める「秒数の整数」形式のみを受理する (単位付き文字列は未対応)。
 * @returns クロール間隔 (秒)
 */
export function getCrawlIntervalSeconds(): number {
  return parsePositiveIntEnv('CRAWL_INTERVAL_SECONDS', 21_600)
}

/**
 * 放置判定のしきい値を「クロール間隔の何倍か」で表す倍率。値が大きいほど、
 * リトライやレート制限で長時間化したサイクルを誤って放置扱いしにくくなる代わりに、
 * 本当に放置された CrawlRun の検出が遅れる。
 * @returns 放置判定のしきい値倍率
 */
export function getCrawlStaleThresholdMultiplier(): number {
  return parsePositiveIntEnv('CRAWL_STALE_THRESHOLD_MULTIPLIER', 3)
}
