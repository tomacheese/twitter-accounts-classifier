'use client'

import { useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

/**
 * @param props - フィルタとして提示するラベルキーの全集合
 * @returns 描画されたフィルタコントロール
 */
export function LabelFilter({
  availableLabelKeys,
}: {
  availableLabelKeys: string[]
}): React.ReactElement {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const selected = new Set(searchParams.getAll('label'))

  function toggle(labelKey: string): void {
    const next = new Set(selected)
    if (next.has(labelKey)) {
      next.delete(labelKey)
    } else {
      next.add(labelKey)
    }
    // page は意図的に削除している。フィルタを変更したときはページ1に戻す必要があるため。
    const params = new URLSearchParams(searchParams)
    params.delete('label')
    for (const key of next) {
      params.append('label', key)
    }
    params.delete('page')
    startTransition(() => {
      router.push(`/accounts?${params.toString()}`)
    })
  }

  return (
    <div
      aria-busy={isPending}
      aria-label="Label filters"
      className="flex flex-wrap gap-2"
      role="group"
    >
      {isPending && (
        <span className="sr-only" role="status">
          Updating accounts
        </span>
      )}
      {availableLabelKeys.map((labelKey) => (
        <button
          key={labelKey}
          type="button"
          disabled={isPending}
          onClick={() => {
            toggle(labelKey)
          }}
          className={
            selected.has(labelKey)
              ? 'rounded-full bg-blue-600 px-3 py-1 text-sm text-white disabled:cursor-wait disabled:opacity-60'
              : 'rounded-full border px-3 py-1 text-sm text-gray-700 disabled:cursor-wait disabled:opacity-60 dark:border-gray-600 dark:text-gray-300'
          }
        >
          {labelKey}
        </button>
      ))}
    </div>
  )
}
