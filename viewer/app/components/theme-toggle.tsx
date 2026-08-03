'use client'

import { useEffect, useState } from 'react'

const STORAGE_KEY = 'theme'

/**
 * ルートレイアウトのブロッキングインラインスクリプトが `<html>` に付与済みの `dark` クラスから、
 * ハイドレーション前に確定済みのテーマを読み取る。
 * @returns ダークモードが有効なら `true`
 */
function readInitialIsDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

/**
 * 初期レンダリングは常にライトモード表示に固定し、マウント後に実際の値へ同期する。
 * `useState` の初期化子で `document` を直接読むと、サーバーには `document` がなく、
 * ダークモード確定時にサーバーとクライアントの描画結果が一致しなくなる。
 * @returns 描画されたトグルボタン
 */
export function ThemeToggle(): React.ReactElement {
  const [isDark, setIsDark] = useState(false)

  useEffect(() => {
    setIsDark(readInitialIsDark())
  }, [])

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
