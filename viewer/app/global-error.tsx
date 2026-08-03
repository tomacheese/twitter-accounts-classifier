'use client'

/**
 * `error.tsx` は `layout.tsx` 自身が投げたエラーは捕捉できないため、
 * ルートレイアウトから漏れた失敗はこちらで受ける。
 * 発火時にルートレイアウトを丸ごと置き換えるため、`<html>`/`<body>` を自前で描画する必要がある。
 * @param props - 捕捉したエラーと再描画をリトライする関数
 * @returns 描画されたエラーページ
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.ReactElement {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-16 text-center text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-gray-600 dark:text-gray-400" role="alert">
          The viewer could not load data. Please try again.
        </p>
        <button
          type="button"
          onClick={() => {
            reset()
          }}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white"
        >
          Retry
        </button>
      </body>
    </html>
  )
}
