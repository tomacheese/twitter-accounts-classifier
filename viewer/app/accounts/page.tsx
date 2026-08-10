import React from 'react'
import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import {
  getLabelKeys,
  listAccounts,
  type AccountSortField,
  type SortDirection,
} from '@/lib/queries/accounts'
import { listAccountSummaries, type AccountSummaryView } from '@/lib/queries/account-summary'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'
import { LabelFilter } from '../components/label-filter'
import { ErrorFallback } from '../components/error-fallback'
import { CursorPagination } from '../components/cursor-pagination'
import { ReadModelReadinessPanel } from '../components/read-model-readiness-panel'

interface AccountsPageProps {
  searchParams: Promise<{
    label?: string | string[]
    sort?: string
    direction?: string
    page?: string
    view?: string
    cursor?: string
  }>
}

const PAGE_SIZE = 20
const SORT_FIELDS: AccountSortField[] = ['followersCount', 'tweetCount', 'lastCrawledAt']
const SORTABLE_COLUMNS: { field: AccountSortField; label: string }[] = [
  { field: 'followersCount', label: 'Followers' },
  { field: 'tweetCount', label: 'Tweets' },
  { field: 'lastCrawledAt', label: 'Last crawled' },
]

/**
 * @param value - 生の検索パラメータの値
 * @returns サポートされているソートフィールドを表す値であれば true
 */
function isAccountSortField(value: string): value is AccountSortField {
  return (SORT_FIELDS as string[]).includes(value)
}

/**
 * @param currentParams - 現在の検索パラメータ。そのまま引き継ぐ
 * @param field - この列のソートフィールド
 * @param currentSort - 現在有効なソートフィールド
 * @param currentDirection - 現在有効なソート方向
 * @returns この列見出しのリンク先
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
 * プレーンオブジェクトへ往復させると繰り返し指定された `label` パラメータを失うため、
 * `URLSearchParams` をそのまま引き継いで組み立てる。
 * @param currentParams - 現在の検索パラメータ。そのまま引き継ぐ
 * @param sortBy - 現在有効なソートフィールド
 * @param sortDirection - 現在有効なソート方向
 * @param targetPage - リンク先とするページ番号
 * @returns このページネーションリンクのリンク先
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
 * 旧 Accounts 一覧画面。`isNewUiSectionEnabled('accounts')` が無効な間はこちらを表示する。
 * 新実装は {@link NewAccountsView} を参照。
 * @param props - `label` (繰り返し指定可能)・`sort`・`direction`・`page` の各検索パラメータ
 * @returns アカウント一覧ページの描画結果
 */
async function LegacyAccountsPage({
  searchParams,
}: AccountsPageProps): Promise<React.ReactElement> {
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
    // error.message には SQL 接続情報などドライバー由来の詳細が含まれうるため、
    // 詳細はサーバー側のログにのみ残し、クライアントには一般的なメッセージだけを返す。
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

/**
 * 新 Accounts 一覧画面。account_summary read model を参照する。
 * `view=recentlyChanged` (既定) は最近分類が変わった順、`view=all` は screenName 順に表示する。
 * @param props - `view`/`cursor` 検索パラメータ
 * @returns アカウント一覧画面の描画結果
 */
async function NewAccountsView({ searchParams }: AccountsPageProps): Promise<React.ReactElement> {
  const params = await searchParams
  const view: AccountSummaryView = params.view === 'recentlyChanged' ? 'recentlyChanged' : 'all'
  const labelKeys = params.label
    ? Array.isArray(params.label)
      ? params.label
      : [params.label]
    : undefined

  const prisma = getPrismaClient()
  try {
    const result = await listAccountSummaries(prisma, {
      view,
      cursor: params.cursor,
      filters: labelKeys ? { labelKeys } : undefined,
    })

    if (result.readiness !== 'ready') {
      return (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">Accounts</h1>
          <ReadModelReadinessPanel status={result.readiness} section="Accounts" />
        </div>
      )
    }

    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Accounts</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Current account classification snapshot. Use Recently changed to inspect classification
            churn.
          </p>
        </div>

        <div className="flex gap-3 text-sm">
          <Link
            href="/accounts?view=all"
            className={
              view === 'all'
                ? 'font-semibold underline'
                : 'text-blue-600 hover:underline dark:text-blue-400'
            }
          >
            All accounts
          </Link>
          <Link
            href="/accounts?view=recentlyChanged"
            className={
              view === 'recentlyChanged'
                ? 'font-semibold underline'
                : 'text-blue-600 hover:underline dark:text-blue-400'
            }
          >
            Recently changed
          </Link>
        </div>

        <div className="rounded-lg border bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-800">
          <span className="font-medium">Data freshness:</span>{' '}
          {result.freshnessStatus === 'healthy'
            ? 'Current'
            : result.freshnessStatus.charAt(0).toUpperCase() + result.freshnessStatus.slice(1)}
        </div>

        {result.items.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No accounts match this view yet.
          </p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-gray-100 dark:bg-gray-700">
              <tr>
                <th className="p-3">Screen name</th>
                <th className="p-3">Display name</th>
                <th className="p-3">Labels</th>
                <th className="p-3">Findings</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.accountId} className="border-t dark:border-gray-700">
                  <td className="p-3">
                    <Link
                      href={`/accounts/${item.accountId}`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      @{item.normalizedScreenName}
                    </Link>
                  </td>
                  <td className="p-3">{item.normalizedDisplayName}</td>
                  <td className="p-3">{item.activeLabelKeys.join(', ') || '—'}</td>
                  <td className="p-3">
                    {item.activeFindingCount > 0
                      ? `${item.activeFindingCount} (${item.highestFindingSeverity ?? 'unknown'})`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CursorPagination
          basePath="/accounts"
          currentParams={params}
          nextCursor={result.nextCursor}
        />
      </div>
    )
  } catch (error) {
    console.error('Failed to load account summaries:', error)
    return <ErrorFallback message="Failed to load the account list." />
  }
}

/**
 * `isNewUiSectionEnabled('accounts')` に応じて新旧いずれかの Accounts 一覧画面を表示する。
 * @param props - Next.js の searchParams
 * @returns 表示すべき Accounts 一覧画面
 */
export default function AccountsPage(props: AccountsPageProps): Promise<React.ReactElement> {
  return isNewUiSectionEnabled('accounts') ? NewAccountsView(props) : LegacyAccountsPage(props)
}
