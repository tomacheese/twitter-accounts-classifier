const JST_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  // hour12: false だけでは ICU の実装によっては深夜0時が "24:00:00" と表示されることがあるため、
  // hourCycle: 'h23' で 00:00:00〜23:59:59 の範囲に固定している。
  hourCycle: 'h23',
})

/**
 * サーバー・クライアントのローカルタイムゾーンに関わらず、
 * 日付を JST (Asia/Tokyo) の `yyyy/MM/dd HH:mm:ss` 形式でフォーマットする。
 */
export function formatDateTime(date: Date): string {
  const parts = Object.fromEntries(
    JST_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

/**
 * `now` を基準に「経過時間 + ago」の相対表記へ変換する。
 * 秒未満の粒度はダッシュボードでの判断に不要なため、日・時・分までに丸める。
 * @param date - 基準にする過去の日時
 * @param now - 現在時刻
 * @returns `3d 4h ago` のような相対経過表記。1分未満は `just now`
 */
export function formatRelativeTime(date: Date, now: Date): string {
  const diffMinutes = Math.floor(Math.max(0, now.getTime() - date.getTime()) / 60_000)
  if (diffMinutes < 1) return 'just now'

  const days = Math.floor(diffMinutes / 1440)
  const hours = Math.floor((diffMinutes % 1440) / 60)
  const minutes = diffMinutes % 60

  if (days > 0) return `${days}d ${hours}h ago`
  if (hours > 0) return `${hours}h ${minutes}m ago`
  return `${minutes}m ago`
}
