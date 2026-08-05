import React from 'react'

/**
 * スクリーンリーダーへ読み込み中であることだけを伝える、視覚的には見えない状態表示。
 * @param props - 読み込み対象を説明するラベル
 * @returns 描画された読み込み状態表示
 */
export function LoadingStatus({ label }: { label: string }): React.ReactElement {
  return (
    <div aria-busy="true" aria-live="polite" role="status">
      <span className="sr-only">Loading {label}</span>
    </div>
  )
}

/**
 * 読み込み完了後のレイアウトシフトを防ぐため、実データと近い寸法で描くプレースホルダー。
 * @param props - 寸法を決める Tailwind クラス
 * @returns 描画されたプレースホルダー要素
 */
export function Skeleton({ className }: { className: string }): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-gray-200 motion-reduce:animate-none dark:bg-gray-700 ${className}`}
    />
  )
}
