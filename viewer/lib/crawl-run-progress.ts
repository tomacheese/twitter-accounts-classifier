/**
 * viewer は crawler のクロール間隔設定を参照できないため、放置判定には
 * 固定のしきい値を使う。通常のアカウント処理時間を大きく超える値にして、
 * 稼働中の長時間処理を誤って停止扱いにしないようにする。
 */
const CURRENT_ACCOUNT_STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000

/**
 * @param currentAccountStartedAt - 表示中のアカウントの処理開始時刻
 * @param now - 現在時刻
 * @returns 処理中表示を継続すべきでないほど時間が経過しているか
 */
export function isCurrentAccountStale(currentAccountStartedAt: Date, now: Date): boolean {
  return now.getTime() - currentAccountStartedAt.getTime() > CURRENT_ACCOUNT_STALE_THRESHOLD_MS
}
