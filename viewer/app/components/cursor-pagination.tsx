import Link from 'next/link'

/** CursorPagination の props。 */
export interface CursorPaginationProps {
  /** 遷移先のパス。 */
  basePath: string
  /** 現在の検索パラメータ。 */
  currentParams: Record<string, string | string[] | undefined>
  /** 次ページの cursor。null なら次ページなし。 */
  nextCursor: string | null
}

/**
 * keyset pagination の次ページリンク。
 * cursor は前方向にしか辿れないため、前ページへのリンクは持たせずブラウザの戻るに委ねる。
 * @param props - 遷移先パスと現在の検索パラメータ、次ページの cursor
 * @returns 次ページがあればリンク、無ければ null
 */
export function CursorPagination({
  basePath,
  currentParams,
  nextCursor,
}: CursorPaginationProps): React.ReactElement | null {
  if (!nextCursor) return null

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(currentParams)) {
    if (key === 'cursor' || value === undefined) continue
    params.set(key, Array.isArray(value) ? (value[0] ?? '') : value)
  }
  params.set('cursor', nextCursor)

  return (
    <div className="flex justify-end text-sm">
      <Link
        href={`${basePath}?${params.toString()}`}
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        Next
      </Link>
    </div>
  )
}
