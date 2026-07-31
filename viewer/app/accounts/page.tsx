import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import {
  getLabelKeys,
  listAccounts,
  type AccountSortField,
  type SortDirection,
} from '@/lib/queries/accounts'
import { LabelFilter } from '../components/label-filter'
import { ErrorFallback } from '../components/error-fallback'

const PAGE_SIZE = 20
const SORT_FIELDS: AccountSortField[] = ['followersCount', 'tweetCount', 'lastCrawledAt']
const SORTABLE_COLUMNS: { field: AccountSortField; label: string }[] = [
  { field: 'followersCount', label: 'Followers' },
  { field: 'tweetCount', label: 'Tweets' },
  { field: 'lastCrawledAt', label: 'Last crawled' },
]

/**
 * Narrows a raw `sort` search param to a sort field the query layer accepts.
 * @param value - the raw search param value
 * @returns true if the value names a supported sort field
 */
function isAccountSortField(value: string): value is AccountSortField {
  return (SORT_FIELDS as string[]).includes(value)
}

/**
 * Builds the `href` for a sortable column header: clicking a column that is
 * not the current sort switches to it (descending by default); clicking the
 * current sort column flips its direction.
 * @param currentParams - the current search params, carried forward as-is
 * @param field - the column's sort field
 * @param currentSort - the currently active sort field
 * @param currentDirection - the currently active sort direction
 * @returns the link target for this column header
 */
function buildSortHref(
  currentParams: URLSearchParams,
  field: AccountSortField,
  currentSort: AccountSortField,
  currentDirection: SortDirection,
): string {
  const params = new URLSearchParams(currentParams)
  params.set('sort', field)
  params.set('direction', field === currentSort && currentDirection === 'desc' ? 'asc' : 'desc')
  params.delete('page')
  return `/accounts?${params.toString()}`
}

/**
 * Builds the `href` for a Previous/Next pagination link, preserving all
 * repeated `label` params (unlike round-tripping through a plain object).
 * @param currentParams - the current search params, carried forward as-is
 * @param sortBy - the currently active sort field
 * @param sortDirection - the currently active sort direction
 * @param targetPage - the page number the link should navigate to
 * @returns the link target for this pagination link
 */
function buildPageHref(
  currentParams: URLSearchParams,
  sortBy: AccountSortField,
  sortDirection: SortDirection,
  targetPage: number,
): string {
  const params = new URLSearchParams(currentParams)
  params.set('sort', sortBy)
  params.set('direction', sortDirection)
  params.set('page', String(targetPage))
  return `/accounts?${params.toString()}`
}

/**
 * Account list page: a filterable, sortable, paginated table of accounts.
 * @param props - the incoming `label` (repeatable), `sort`, `direction`, and `page` search params
 * @returns the rendered account list page
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{
    label?: string | string[]
    sort?: string
    direction?: string
    page?: string
  }>
}): Promise<React.ReactElement> {
  const params = await searchParams
  const labelKeys = params.label
    ? Array.isArray(params.label)
      ? params.label
      : [params.label]
    : undefined
  const page = Math.max(1, Math.trunc(Number(params.page)) || 1)
  const sortBy: AccountSortField =
    params.sort && isAccountSortField(params.sort) ? params.sort : 'followersCount'
  const sortDirection: SortDirection = params.direction === 'asc' ? 'asc' : 'desc'

  const prisma = getPrismaClient()
  let items: Awaited<ReturnType<typeof listAccounts>>['items']
  let totalCount: number
  let availableLabelKeys: string[]
  try {
    ;[{ items, totalCount }, availableLabelKeys] = await Promise.all([
      listAccounts(prisma, {
        labelKeys,
        page,
        pageSize: PAGE_SIZE,
        sortBy,
        sortDirection,
      }),
      getLabelKeys(prisma),
    ])
  } catch (error) {
    // Log the full error server-side but show the client a generic message:
    // error.message can leak SQL/connection details from the driver.
    console.error('Failed to load account list or label keys:', error)
    return <ErrorFallback message="Failed to load the account list." />
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const currentParams = new URLSearchParams()
  for (const labelKey of labelKeys ?? []) {
    currentParams.append('label', labelKey)
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Accounts</h1>
      <LabelFilter availableLabelKeys={availableLabelKeys} />

      {items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No accounts match the current filter.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-100 text-left dark:bg-gray-700">
              <tr>
                <th className="p-3">Screen name</th>
                <th className="p-3">Display name</th>
                {SORTABLE_COLUMNS.map((column) => (
                  <th key={column.field} className="p-3">
                    <Link
                      href={buildSortHref(currentParams, column.field, sortBy, sortDirection)}
                      className="hover:underline"
                    >
                      {column.label}
                      {sortBy === column.field ? (sortDirection === 'desc' ? ' ▼' : ' ▲') : ''}
                    </Link>
                  </th>
                ))}
                <th className="p-3">Blue verified</th>
                <th className="p-3">Labels</th>
              </tr>
            </thead>
            <tbody>
              {items.map((account) => (
                <tr key={account.id} className="border-t dark:border-gray-700">
                  <td className="p-3">
                    <Link
                      href={`/accounts/${account.id}`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      @{account.screenName}
                    </Link>
                  </td>
                  <td className="p-3">{account.displayName}</td>
                  <td className="p-3">{account.followersCount.toLocaleString()}</td>
                  <td className="p-3">{account.tweetCount.toLocaleString()}</td>
                  <td className="p-3">{formatDateTime(account.lastCrawledAt)}</td>
                  <td className="p-3">{account.isBlueVerified ? 'Yes' : 'No'}</td>
                  <td className="p-3">{account.activeLabelKeys.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
        <span>
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-3">
          {page > 1 && (
            <Link
              href={buildPageHref(currentParams, sortBy, sortDirection, page - 1)}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Previous
            </Link>
          )}
          {page < totalPages && (
            <Link
              href={buildPageHref(currentParams, sortBy, sortDirection, page + 1)}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Next
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
