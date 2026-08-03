'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * `/` だけは完全一致にし、それ以外は前方一致で判定する。
 * 前方一致にしないと `/accounts/[id]` のようなネストしたルートで「Accounts」がハイライトされない。
 * @param props - リンク先とラベル
 * @returns 描画されたナビリンク
 */
export function NavLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}): React.ReactElement {
  const pathname = usePathname()
  const isActive = href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <Link
      href={href}
      aria-current={isActive ? 'page' : undefined}
      className={
        isActive
          ? 'text-blue-600 dark:text-blue-400'
          : 'text-gray-700 hover:text-blue-600 dark:text-gray-300 dark:hover:text-blue-400'
      }
    >
      {children}
    </Link>
  )
}
