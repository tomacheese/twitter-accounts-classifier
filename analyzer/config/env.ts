/**
 * 環境変数を正の整数として読み取る。未設定・空文字ならデフォルト値を返す。
 * `Number()` は 16 進数・指数表記・符号付き文字列なども受理してしまうため、
 * 10 進数の数字列のみを許可する正規表現で事前に絞り込む。
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
 * worker ループを何並列で走らせるか。
 * analyzer は crawler/blocker と違って queue 消費型のため、
 * 単一プロセス内で複数の poll ループを並走させて捌く。
 * @returns 並列数
 */
export function getWorkerConcurrency(): number {
  return parsePositiveIntEnv('ANALYZER_WORKER_CONCURRENCY', 1)
}
