/**
 * @param startedAt - 開始時刻
 * @param finishedAt - 終了時刻
 * @returns 人間が読める形式の経過時間
 */
export function formatDuration(startedAt: Date, finishedAt: Date): string {
  const totalSeconds = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = hours > 0 ? [`${hours}h`, `${String(minutes).padStart(2, '0')}m`] : [`${minutes}m`]
  parts.push(`${String(seconds).padStart(2, '0')}s`)
  return parts.join(' ')
}
