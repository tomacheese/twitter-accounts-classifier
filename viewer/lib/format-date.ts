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
 * サーバー・クライアントのローカルタイムゾーンに関わらず、日付を JST (Asia/Tokyo) の `yyyy/MM/dd HH:mm:ss` 形式でフォーマットする。
 */
export function formatDateTime(date: Date): string {
  const parts = Object.fromEntries(
    JST_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}
