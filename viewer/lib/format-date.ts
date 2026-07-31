const JST_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  // `hour12: false` alone can render midnight as "24:00:00" in some ICU implementations;
  // `hourCycle: 'h23'` pins it to the expected 00:00:00-23:59:59 range.
  hourCycle: 'h23',
})

/**
 * Formats a Date as `yyyy/MM/dd HH:mm:ss` in JST (Asia/Tokyo), regardless of the
 * server/client's local timezone.
 */
export function formatDateTime(date: Date): string {
  const parts = Object.fromEntries(
    JST_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}
