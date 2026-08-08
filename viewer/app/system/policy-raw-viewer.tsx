'use client'

import { useState } from 'react'

/**
 * Active policy の生設定を初期折りたたみで表示し、
 * 展開時のみ `/api/system/policy` から取得する。
 * 設定は数百行になりうるため、常時取得せずユーザー操作を起点にする。
 * @returns 展開可能な Active policy 生設定ビューア
 */
export function PolicyRawViewer(): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleToggle = (): void => {
    if (isExpanded) {
      setIsExpanded(false)
      return
    }
    setIsExpanded(true)
    if (content !== null || isLoading) return

    setIsLoading(true)
    setError(null)
    fetch('/api/system/policy')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unexpected status: ${String(response.status)}`)
        const data = (await response.json()) as { content: unknown }
        setContent(JSON.stringify(data.content, null, 2))
      })
      .catch((fetchError: unknown) => {
        console.error('Failed to load the active policy content:', fetchError)
        setError('Failed to load the active policy content.')
      })
      .finally(() => {
        setIsLoading(false)
      })
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        className="rounded border px-3 py-1 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-700"
      >
        {isExpanded ? 'Hide raw policy' : 'Show raw policy'}
      </button>
      {isExpanded && (
        <div className="mt-2">
          {isLoading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {content !== null && !isLoading && !error && (
            <pre className="overflow-x-auto rounded bg-gray-100 p-3 text-xs dark:bg-gray-900">
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
