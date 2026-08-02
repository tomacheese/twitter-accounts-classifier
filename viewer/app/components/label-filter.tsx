'use client'

import { useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

/**
 * Renders a row of toggleable label checkboxes that update the `label`
 * query parameter (repeated per selected label) on the current page.
 * @param props - the full set of known label keys to offer as filters
 * @returns the rendered filter control
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
    // Carry every other active param (sort, direction) forward as-is; only
    // `label` is rebuilt from `next`, and `page` is deliberately dropped,
    // since changing the filter should reset pagination back to page 1.
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
