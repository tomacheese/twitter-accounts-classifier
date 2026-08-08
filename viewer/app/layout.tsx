import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'
import { SiteNav } from './components/site-nav'
import { getPrismaClient } from '@/lib/prisma'
import { getNavBadgeCounts } from '@/lib/queries/global-search'
import { listEnabledNewUiSections } from '@/lib/feature-flags'

// hydration 前に適用することで、最初の描画から保存済みの選択 (未保存なら OS の設定) に合わせ、
// ライトモードが一瞬表示されるのを防ぐ。
const THEME_INIT_SCRIPT = `
(function () {
  var stored = localStorage.getItem('theme')
  var isDark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', isDark)
})()
`

export const metadata: Metadata = {
  title: 'Labeling Results Viewer',
  description: 'Dashboard for Twitter account labeling results',
}

/**
 * @param props - レイアウト内に描画するページ本体
 * @returns ナビゲーションを含む HTML ドキュメントの骨格
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}): Promise<React.ReactElement> {
  const enabledSections = listEnabledNewUiSections()
  const needsBadgeCounts =
    enabledSections.includes('review') || enabledSections.includes('operations')
  // badge 件数の取得に失敗してもナビゲーション自体は必ず描画する必要があるため、
  // ここでの失敗は 0 件表示にフォールバックする。
  const badgeCounts = needsBadgeCounts
    ? await getNavBadgeCounts(getPrismaClient()).catch((error: unknown) => {
        console.error('Failed to load nav badge counts:', error)
        return { qualityReviewCount: 0, operationsCount: 0 }
      })
    : { qualityReviewCount: 0, operationsCount: 0 }

  return (
    <html lang="en">
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
      </head>
      <body className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <SiteNav
          enabledSections={enabledSections}
          qualityReviewBadgeCount={badgeCounts.qualityReviewCount}
          operationsBadgeCount={badgeCounts.operationsCount}
        />
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </body>
    </html>
  )
}
