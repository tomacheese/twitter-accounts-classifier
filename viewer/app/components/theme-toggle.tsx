'use client'

import { useEffect, useState } from 'react'

const STORAGE_KEY = 'theme'

/**
 * Reads the theme the blocking inline script in the root layout already
 * applied to `<html>` before hydration, via the `dark` class it set there.
 * @returns `true` if dark mode is currently active
 */
function readInitialIsDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

/**
 * A manual light/dark theme toggle. Persists the user's explicit choice
 * to `localStorage` so it overrides the OS-level `prefers-color-scheme`
 * on every later visit.
 *
 * Initial render always shows the light-mode label to match the server's
 * markup, then syncs to the real value on mount — reading `document`
 * directly in the `useState` initializer would mismatch whenever the
 * resolved theme is dark, since the server has no `document` to read.
 * @returns the rendered toggle button
 */
export function ThemeToggle(): React.ReactElement {
  const [isDark, setIsDark] = useState(false)

  useEffect(() => {
    setIsDark(readInitialIsDark())
  }, [])

  /** Flips the active theme, applies it to `<html>`, and persists the choice. */
  function toggle(): void {
    const next = !isDark
    setIsDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light')
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="rounded-md border px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
    >
      {isDark ? '☀️ Light' : '🌙 Dark'}
    </button>
  )
}
