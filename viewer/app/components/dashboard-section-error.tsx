import React from 'react'
import { SectionRetry } from './section-retry'

interface DashboardSectionErrorProps {
  headingId: string
  title: string
  message: string
}

/**
 * ダッシュボードの各セクションはそれぞれ独立した `Suspense` 境界を持つため、
 * 1セクションの取得失敗が他セクションの表示を巻き込まないよう、
 * ルート全体を差し替える `ErrorFallback` ではなくセクション単位の再試行 UI を使う。
 * @param props - 見出し ID・タイトル・エラーメッセージ
 * @returns 描画されたセクション単位のエラー表示
 */
export function DashboardSectionError({
  headingId,
  title,
  message,
}: DashboardSectionErrorProps): React.ReactElement {
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950"
    >
      <h2 id={headingId} className="text-lg font-semibold">
        {title}
      </h2>
      <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
        {message}
      </p>
      <SectionRetry />
    </section>
  )
}
