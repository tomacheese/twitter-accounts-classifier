'use client'

import { useState } from 'react'
import { NavLink } from './nav-link'
import { ThemeToggle } from './theme-toggle'

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/labels', label: 'Labels' },
  { href: '/weekly-runs', label: 'Weekly Runs' },
  { href: '/crawl-runs', label: 'Crawl Runs' },
] as const

/**
 * The site-wide navigation bar. Below the `sm` breakpoint it collapses to a
 * hamburger toggle, since the nav links plus the theme toggle do not fit a
 * narrow viewport in one row without wrapping mid-word.
 * @returns the rendered navigation bar
 */
export function SiteNav(): React.ReactElement {
  const [isMenuOpen, setIsMenuOpen] = useState(false)

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
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.href} href={item.href}>
              {item.label}
            </NavLink>
          ))}
        </div>

        <div className="hidden sm:block">
          <ThemeToggle />
        </div>
      </div>

      {isMenuOpen && (
        <div
          className="mt-3 flex flex-col gap-3 border-t pt-3 text-sm font-medium sm:hidden dark:border-gray-700"
          onClick={() => {
            // Collapse the menu once a link inside it is followed, so it
            // doesn't stay open over the newly navigated-to page.
            setIsMenuOpen(false)
          }}
        >
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.href} href={item.href}>
              {item.label}
            </NavLink>
          ))}
          <ThemeToggle />
        </div>
      )}
    </nav>
  )
}
