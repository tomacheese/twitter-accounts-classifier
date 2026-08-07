'use client'

import React, { useState } from 'react'
import { NavLink } from './nav-link'
import { ThemeToggle } from './theme-toggle'
import { GlobalSearch } from './global-search'

interface NavItem {
  href: string
  label: string
  badgeCount?: number
}

const LEGACY_NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/labels', label: 'Labels' },
  { href: '/weekly-runs', label: 'Weekly Runs' },
  { href: '/crawl-runs', label: 'Crawl Runs' },
  { href: '/block-runs', label: 'Block Runs' },
]

export interface SiteNavProps {
  /** `isNewUiSectionEnabled('overview')` が有効なら新ナビゲーション項目一式を表示する */
  isNewNavEnabled: boolean
  qualityReviewBadgeCount: number
  operationsBadgeCount: number
}

/**
 * 新ナビゲーション項目一式。`isNewNavEnabled` が有効な間だけ表示する。
 * @param badges - Quality Review / Operations の badge 件数
 * @returns 新ナビゲーション項目一覧
 */
function buildNewNavItems(badges: {
  qualityReviewBadgeCount: number
  operationsBadgeCount: number
}): NavItem[] {
  return [
    { href: '/overview', label: 'Overview' },
    { href: '/review', label: 'Quality Review', badgeCount: badges.qualityReviewBadgeCount },
    { href: '/accounts', label: 'Accounts' },
    { href: '/labels', label: 'Labels' },
    { href: '/operations', label: 'Operations', badgeCount: badges.operationsBadgeCount },
    { href: '/blocks', label: 'Blocks' },
    { href: '/system', label: 'System' },
  ]
}

/**
 * ナビリンクとテーマ切り替えを1行に収めると狭い画面幅では折り返すため、
 * `sm` ブレークポイント未満ではハンバーガーメニューに折りたたむ。
 * @param props - 新ナビゲーション有効フラグと badge 件数
 * @returns 描画されたナビゲーションバー
 */
export function SiteNav({
  isNewNavEnabled,
  qualityReviewBadgeCount,
  operationsBadgeCount,
}: SiteNavProps): React.ReactElement {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const navItems = isNewNavEnabled
    ? buildNewNavItems({ qualityReviewBadgeCount, operationsBadgeCount })
    : LEGACY_NAV_ITEMS

  return (
    <nav
      aria-label="Primary navigation"
      className="border-b bg-white px-4 py-3 shadow-sm sm:px-6 sm:py-4 dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => {
            setIsMenuOpen((open) => !open)
          }}
          aria-label={isMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={isMenuOpen}
          className="rounded-md border px-2 py-1 text-sm text-gray-700 sm:hidden dark:border-gray-600 dark:text-gray-300"
        >
          {isMenuOpen ? '✕' : '☰'}
        </button>

        <div className="hidden gap-6 text-sm font-medium sm:flex">
          {navItems.map((item) => (
            <NavLink key={item.href} href={item.href}>
              {item.label}
              {!!item.badgeCount && item.badgeCount > 0 && (
                <span className="ml-1 rounded-full bg-red-600 px-1.5 py-0.5 text-xs text-white">
                  {item.badgeCount}
                </span>
              )}
            </NavLink>
          ))}
        </div>

        {isNewNavEnabled && (
          <div className="hidden sm:block">
            <GlobalSearch />
          </div>
        )}

        <div className="hidden sm:block">
          <ThemeToggle />
        </div>
      </div>

      {isMenuOpen && (
        <div
          className="mt-3 flex flex-col gap-3 border-t pt-3 text-sm font-medium sm:hidden dark:border-gray-700"
          onClick={() => {
            // リンクをたどった際にメニューを閉じる。遷移後のページ上に開いたまま残さないため。
            setIsMenuOpen(false)
          }}
        >
          {navItems.map((item) => (
            <NavLink key={item.href} href={item.href}>
              {item.label}
              {!!item.badgeCount && item.badgeCount > 0 && (
                <span className="ml-1 rounded-full bg-red-600 px-1.5 py-0.5 text-xs text-white">
                  {item.badgeCount}
                </span>
              )}
            </NavLink>
          ))}
          {isNewNavEnabled && <GlobalSearch />}
          <ThemeToggle />
        </div>
      )}
    </nav>
  )
}
