'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import type { GlobalSearchResult } from '@/lib/queries/global-search'

const DEBOUNCE_MS = 300

/**
 * Account/Label/Finding/Operation を横断検索する。Tweet 本文は検索対象に含まれない。
 * 入力のたびに叩くと DB 負荷が高いため、入力停止から一定時間後にのみ検索する。
 * @returns 描画された Global Search 入力欄と結果一覧
 */
export function GlobalSearch(): React.ReactElement {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<GlobalSearchResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setResult(null)
      return
    }

    setIsLoading(true)
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`Unexpected status: ${String(response.status)}`)
          const data = (await response.json()) as GlobalSearchResult
          setResult(data)
        })
        .catch((error: unknown) => {
          console.error('Failed to search:', error)
          setResult(null)
        })
        .finally(() => {
          setIsLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [query])

  const hasResults =
    result !== null &&
    (result.accounts.length > 0 ||
      result.labels.length > 0 ||
      result.findings.length > 0 ||
      result.operations.length > 0)

  return (
    <div className="relative w-full max-w-xs">
      <input
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
        }}
        placeholder="Search accounts, labels, findings, operations"
        aria-label="Global search"
        className="w-full rounded-md border px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
      />
      {query.trim() && (
        <div className="absolute z-10 mt-1 w-full rounded-md border bg-white p-2 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-800">
          {isLoading && <p className="text-gray-500 dark:text-gray-400">Searching...</p>}
          {!isLoading && !hasResults && (
            <p className="text-gray-500 dark:text-gray-400">No results.</p>
          )}
          {!isLoading && result && (
            <ul className="flex flex-col gap-2">
              {result.accounts.map((account) => (
                <li key={`account-${account.id}`}>
                  <Link href={`/accounts/${account.id}`} className="hover:underline">
                    Account: {account.screenName} ({account.displayName})
                  </Link>
                </li>
              ))}
              {result.labels.map((label) => (
                <li key={`label-${label.id}`}>
                  <Link
                    href={`/labels/${encodeURIComponent(label.key)}`}
                    className="hover:underline"
                  >
                    Label: {label.key}
                  </Link>
                </li>
              ))}
              {result.findings.map((finding) => (
                <li key={`finding-${finding.id}`}>
                  <Link href={`/review/findings/${finding.id}`} className="hover:underline">
                    Finding: {finding.type}
                  </Link>
                </li>
              ))}
              {result.operations.map((operation) => (
                <li key={`operation-${operation.id}`}>
                  <Link href="/operations" className="hover:underline">
                    Operation: {operation.id} ({operation.kind})
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
