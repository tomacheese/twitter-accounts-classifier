import React from 'react'

export type StatTileTone = 'neutral' | 'success' | 'warning' | 'danger'

/**
 * 累積カウント (neutral) と、失敗・警告のように注意を要する値 (warning/danger) を
 * 見た目で区別できるよう、トーンごとに文字色を変える。
 */
const VALUE_TONE_STYLES = {
  neutral: '',
  success: 'text-green-600 dark:text-green-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
} satisfies Record<StatTileTone, string>

/**
 * @param props - タイルに表示するラベル・値・トーン (省略時は neutral)
 * @returns 描画された stat タイル
 */
export function StatTile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: StatTileTone
}): React.ReactElement {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${VALUE_TONE_STYLES[tone]}`}>{value}</p>
    </div>
  )
}
