'use client'

import React, { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import Link from 'next/link'
import type { LabelDistributionEntry } from '@/lib/queries/dashboard'

const BAR_COLOR = '#2563eb'
const MOBILE_BREAKPOINT_PX = 640
const MOBILE_AXIS_WIDTH = 80
const DESKTOP_AXIS_WIDTH = 140

/**
 * 画面幅に応じて Y 軸のラベル幅を切り替える。SVG の軸幅は CSS メディアクエリでは
 * 制御できないため、リサイズを監視して数値を出し分けている。
 * @returns 現在の画面幅に応じた Y 軸のラベル幅
 */
function useAxisWidth(): number {
  const [width, setWidth] = useState(DESKTOP_AXIS_WIDTH)

  useEffect(() => {
    const updateWidth = (): void => {
      setWidth(window.innerWidth < MOBILE_BREAKPOINT_PX ? MOBILE_AXIS_WIDTH : DESKTOP_AXIS_WIDTH)
    }
    updateWidth()
    window.addEventListener('resize', updateWidth)
    return () => {
      window.removeEventListener('resize', updateWidth)
    }
  }, [])

  return width
}

/**
 * @param props - グラフ化するラベル分布のエントリ一覧
 * @returns 描画されたチャート
 */
export function LabelDistributionChart({
  entries,
}: {
  entries: LabelDistributionEntry[]
}): React.ReactElement {
  const axisWidth = useAxisWidth()

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <p className="text-sm text-gray-500 dark:text-gray-400">No label data available yet.</p>
      </div>
    )
  }

  // 母数 (totalAccounts) がラベルごとに異なるため、
  // 陽性数そのものを棒として比較すると母数の差が誤って優劣に見えてしまう。
  // 棒には母数に依存しない陽性率を使い、陽性数・母数は凡例側の文字列で併記する。
  const data = entries.map((entry) => ({
    label: entry.labelKey,
    percentage: entry.totalAccounts === 0 ? 0 : (entry.trueCount / entry.totalAccounts) * 100,
    trueCount: entry.trueCount,
    totalAccounts: entry.totalAccounts,
  }))

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <ResponsiveContainer width="100%" height={Math.max(200, entries.length * 40)}>
        <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis type="number" domain={[0, 100]} tickFormatter={(value: number) => `${value}%`} />
          <YAxis type="category" dataKey="label" width={axisWidth} />
          <Tooltip
            formatter={(_value, _name, item) => {
              const payload = item.payload as (typeof data)[number]
              return [
                `${payload.trueCount}/${payload.totalAccounts} (${Math.round(payload.percentage)}%)`,
                'Positive rate',
              ]
            }}
          />
          <Bar dataKey="percentage" fill={BAR_COLOR} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <ul className="mt-4 flex flex-wrap gap-3 text-sm">
        {entries.map((entry) => {
          const percentage =
            entry.totalAccounts === 0
              ? 0
              : Math.round((entry.trueCount / entry.totalAccounts) * 100)
          return (
            <li key={entry.labelKey}>
              <Link
                href={`/accounts?label=${encodeURIComponent(entry.labelKey)}`}
                className="text-blue-600 hover:underline dark:text-blue-400"
                title={entry.labelDescription}
              >
                {entry.labelKey}: {entry.trueCount}/{entry.totalAccounts} ({percentage}%)
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
