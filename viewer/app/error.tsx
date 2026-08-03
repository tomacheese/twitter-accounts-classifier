'use client'

/**
 * ルートレイアウト自体から漏れた失敗のみを拾う `global-error.tsx` とは異なり、
 * こちらは各セグメント配下でのデータ取得失敗を拾う。
 * @param props - 捕捉したエラーと再描画をリトライする関数
 * @returns 描画されたエラーページ
 */
export default function SegmentError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
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
    </div>
  )
}
