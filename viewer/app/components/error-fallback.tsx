/**
 * ページ自身のデータ取得が失敗した際に使うサーバーレンダリング可能なエラー表示。
 * `error.tsx` の境界は Client Component でハイドレーション後にしか描画されず、
 * 最初の HTTP レスポンスが空白になるため、catch した失敗にはこちらを優先する。
 * @param props - 表示するメッセージ
 * @returns 描画されたフォールバック
 */
export function ErrorFallback({ message }: { message: string }): React.ReactElement {
  return (
    <div
      aria-live="assertive"
      className="flex flex-col items-center gap-4 py-16 text-center"
      role="alert"
    >
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-gray-600 dark:text-gray-400">{message}</p>
    </div>
  )
}
