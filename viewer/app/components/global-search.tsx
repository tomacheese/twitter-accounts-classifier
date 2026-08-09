'use client'

import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { GlobalSearchResult } from '@/lib/queries/global-search'

const DEBOUNCE_MS = 300

/**
 * Operations 詳細ページの route は kind ごとに異なる (crawl/review/block) ため、
 * OperationCycle.kind の値からその接頭辞へ変換する。
 */
const OPERATION_KIND_TO_PATH: Record<string, string> = {
  crawl: 'crawl',
  weekly_review: 'review',
  block: 'block',
}

/**
 * @param cycleId - 対象 OperationCycle の ID
 * @param kind - OperationCycle.kind
 * @returns Operations 詳細ページの URL
 */
export function buildOperationCycleHref(cycleId: string, kind: string): string {
  return `/operations/${OPERATION_KIND_TO_PATH[kind] ?? kind}/${cycleId}`
}

/** 検索結果ドロップダウンが取りうる表示状態。 */
export type GlobalSearchDisplayState = 'loading' | 'error' | 'empty' | 'results'

/**
 * 検索失敗を result: null で表すと「該当なし」と同じ表示になり、
 * 検索対象が存在しないという誤った断定を出してしまう。
 * error を独立した状態として持ち、empty より先に判定する。
 * @param input - 現在の読み込み状態・エラー・検索結果
 * @returns 描画すべき表示状態
 */
export function resolveDisplayState(input: {
  isLoading: boolean
  error: string | null
  result: GlobalSearchResult | null
}): GlobalSearchDisplayState {
  if (input.isLoading) return 'loading'
  if (input.error !== null) return 'error'
  const { result } = input
  const hasResults =
    result !== null &&
    (result.accounts.length > 0 ||
      result.labels.length > 0 ||
      result.findings.length > 0 ||
      result.operations.length > 0)
  return hasResults ? 'results' : 'empty'
}

/**
 * Account/Label/Finding/Operation を横断検索する。
 * 入力のたびに叩くと DB 負荷が高いため、入力停止から一定時間後にのみ検索する。
 * @returns 描画された Global Search 入力欄と結果一覧
 */
export function GlobalSearch(): React.ReactElement {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<GlobalSearchResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setResult(null)
      setError(null)
      return
    }

    setIsLoading(true)
    const timer = setTimeout(() => {
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Unexpected status: ${String(response.status)}`)
          const data = (await response.json()) as GlobalSearchResult
          setResult(data)
          setError(null)
        })
        .catch((fetchError: unknown) => {
          if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return
          console.error('Failed to search:', fetchError)
          setResult(null)
          setError('Failed to search.')
        })
        .finally(() => {
          // abort された古い fetch の finally が、後発の fetch がまだ進行中の isLoading を誤って false に戻すことがあるため、この fetch がまだ最新かを確認する。
          if (controllerRef.current === controller) setIsLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controllerRef.current?.abort()
    }
  }, [query])

  const displayState = resolveDisplayState({ isLoading, error, result })

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
          {displayState === 'loading' && (
            <p className="text-gray-500 dark:text-gray-400">Searching...</p>
          )}
          {displayState === 'error' && <p className="text-red-600 dark:text-red-400">{error}</p>}
          {displayState === 'empty' && (
            <p className="text-gray-500 dark:text-gray-400">No results.</p>
          )}
          {displayState === 'results' && result && (
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
                  <Link
                    href={buildOperationCycleHref(operation.id, operation.kind)}
                    className="hover:underline"
                  >
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
