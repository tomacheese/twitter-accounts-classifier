import { getBlockActionDelayMs, getBlockIntervalSeconds, getBlockMaxPerAccountPerRun } from './env'

/**
 * ブロック実行の上限値一式。
 */
export interface BlockLimits {
  intervalSeconds: number
  actionDelayMs: number
  maxPerAccountPerRun: number
}

/**
 * 起動時に一度だけ環境変数を読み、以降は同じ値を各モジュールに配ることで、
 * サイクル実行中に環境変数が変化しても挙動が揺れないようにする。
 * @returns 現在の環境変数から解決したブロック実行の上限値一式
 */
export function loadBlockLimits(): BlockLimits {
  return {
    intervalSeconds: getBlockIntervalSeconds(),
    actionDelayMs: getBlockActionDelayMs(),
    maxPerAccountPerRun: getBlockMaxPerAccountPerRun(),
  }
}
