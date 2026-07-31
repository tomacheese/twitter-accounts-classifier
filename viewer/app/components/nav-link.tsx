'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * A top-nav link that highlights itself when its `href` matches the current route
 * (exact match for `/`, prefix match otherwise so nested routes like
 * `/accounts/[id]` still highlight "Accounts").
 * @param props - the link's target and label
 * @returns the rendered nav link
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
