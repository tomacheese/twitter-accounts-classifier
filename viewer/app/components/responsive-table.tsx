import React from 'react'

/** ResponsiveTable の列定義。priority: secondary はモバイル表示で折り畳む。 */
export interface ResponsiveTableColumn<T> {
  key: string
  header: string
  priority: 'primary' | 'secondary'
  render: (row: T) => React.ReactNode
}

interface ResponsiveTableProps<T> {
  columns: ResponsiveTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
}

/**
 * デスクトップでは通常の table、モバイル (md 未満) では行を card 化して表示する共通テーブル。
 * JS で幅を判定せず CSS の md: breakpoint で切り替えることで、
 * SSR 結果とハイドレーション後の表示を一致させる。
 * @param props - 列定義・行データ・行キー抽出関数
 * @returns 描画結果
 */
export function ResponsiveTable<T>({
  columns,
  rows,
  rowKey,
}: ResponsiveTableProps<T>): React.ReactElement {
  const primaryColumns = columns.filter((column) => column.priority === 'primary')
  const secondaryColumns = columns.filter((column) => column.priority === 'secondary')

  return (
    <>
      <table className="hidden w-full border-collapse text-left text-sm md:table">
        <thead className="bg-gray-100 dark:bg-gray-700">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className="p-3">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-t dark:border-gray-700">
              {columns.map((column) => (
                <td key={column.key} className="p-3">
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <div
            key={rowKey(row)}
            className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
          >
            {primaryColumns.map((column) => (
              <div key={column.key} className="flex justify-between gap-2">
                <span className="text-gray-500 dark:text-gray-400">{column.header}</span>
                <span>{column.render(row)}</span>
              </div>
            ))}
            {secondaryColumns.length > 0 && (
              <details>
                <summary className="mt-2 cursor-pointer text-xs text-gray-400 dark:text-gray-500">
                  More
                </summary>
                <div className="mt-2 flex flex-col gap-1">
                  {secondaryColumns.map((column) => (
                    <div key={column.key} className="flex justify-between gap-2">
                      <span className="text-gray-500 dark:text-gray-400">{column.header}</span>
                      <span>{column.render(row)}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
