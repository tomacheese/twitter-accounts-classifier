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
 * アカウントごとの警告件数が GlitchTip 通知を発火させるしきい値を読み取る (runAccountCycle 参照)。
 * getCookieIssuerBaseUrl と異なり、これは必須設定ではなく任意の運用調整値であるため、
 * 未設定・非正・非整数の値は実行を止めずに DEFAULT_CRAWL_WARNING_THRESHOLD へフォールバックする。
 * @returns 設定されたしきい値。未設定または不正な場合は DEFAULT_CRAWL_WARNING_THRESHOLD
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

/**
 * 環境変数を正の整数として読み取る。未設定・空文字ならデフォルト値を返す。
 * `Number()` は 16進数・指数表記・符号付き文字列なども受理してしまうため、
 * 10進数の数字列のみを許可する正規表現で事前に絞り込む。
 * エラーメッセージには入力値そのものを含めない。
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
 * TypeScript 側でも放置判定のしきい値算出に利用する。
 * 未設定時は、README が定める entrypoint.sh 側デフォルトと合わせて 21600 (6時間) とする。
 * entrypoint.sh の `sleep` はシェルの流儀で `6h` のような単位付き文字列も受理するが、
 * こちらは README が定める「秒数の整数」形式のみを受理する (単位付き文字列は未対応)。
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

/**
 * 週次分析の停止放置判定しきい値 (秒)。1回のハートビート間隔として妥当な値の何倍かではなく、
 * CI 待ちやレビュー対応を挟む長時間ワークフローであるため、直接秒数で設定できるようにしている。
 * @returns 停止放置判定のしきい値 (秒)
 */
export function getWeeklyAnalysisStaleThresholdSeconds(): number {
  return parsePositiveIntEnv('WEEKLY_ANALYSIS_STALE_THRESHOLD_SECONDS', 7200)
}

/**
 * cycletls 経由の 1 リクエストに設ける Node 側の上限時間 (ミリ秒)。
 * cycletls 自体の内部 timeout (既定 20 秒) は Node↔Go 間の接続確立にのみ適用され、
 * 確立済み接続でのリクエスト自体には効かないため、別途上限を設ける。
 * @returns 設定された上限時間 (ミリ秒)。未設定時は 60000 (60 秒)
 */
export function getTwitterRequestTimeoutMs(): number {
  return parsePositiveIntEnv('TWITTER_REQUEST_TIMEOUT_MS', 60_000)
}

/**
 * 1 account の crawl 処理 (外部通信フェーズ全体) に設ける上限時間 (ミリ秒)。
 * @returns 設定された上限時間 (ミリ秒)。未設定時は 3600000 (60 分)
 */
export function getCrawlAccountTimeoutMs(): number {
  return parsePositiveIntEnv('CRAWL_ACCOUNT_TIMEOUT_MS', 3_600_000)
}

/**
 * relabeler の producer (stale scan) が 1 cycle あたりに scan する Account 件数。
 * @returns producer の batch size
 */
export function getRelabelerProducerBatchSize(): number {
  return parsePositiveIntEnv('RELABELER_PRODUCER_BATCH_SIZE', 5000)
}

/**
 * relabeler の worker (queue drain) が 1 レーンあたりに claim する work item の上限件数
 * (concurrency 分の合計ではない)。
 * @returns worker の batch size
 */
export function getRelabelerWorkerBatchSize(): number {
  return parsePositiveIntEnv('RELABELER_WORKER_BATCH_SIZE', 2000)
}

/**
 * relabeler の worker が evaluate フェーズを並列実行するレーン数。
 * @returns worker の並行度
 */
export function getRelabelerWorkerConcurrency(): number {
  return parsePositiveIntEnv('RELABELER_WORKER_CONCURRENCY', 1)
}

/**
 * follow-graph index 構築の1回の SQL 呼び出し、および claim/evaluate 1 回あたりの account 件数。
 * @returns worker chunk size
 */
export function getRelabelerWorkerChunkSize(): number {
  return parsePositiveIntEnv('RELABELER_WORKER_CHUNK_SIZE', 1000)
}

/**
 * scanForStaleAccounts が AccountLabelLatest を lookup する際の1回あたりの account 件数。
 * @returns label lookup chunk size
 */
export function getRelabelerLabelLookupChunkSize(): number {
  return parsePositiveIntEnv('RELABELER_LABEL_LOOKUP_CHUNK_SIZE', 1000)
}

/**
 * lease 失効 + attemptCount 使い切りで取り残された account_relabel 行を、
 * 1 cycle あたりにどれだけ回収するかの上限。大量の取り残しが溜まっていても
 * 1 回の UPDATE が長時間化しないよう小さい値に抑える。
 * @returns orphan recovery の batch size
 */
export function getRelabelerOrphanRecoveryBatchSize(): number {
  return parsePositiveIntEnv('RELABELER_ORPHAN_RECOVERY_BATCH_SIZE', 1000)
}
