'use client'

import React, { useTransition } from 'react'
import { useRouter } from 'next/navigation'

export function SectionRetry(): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        startTransition(() => {
          router.refresh()
        })
      }}
      className="mt-3 rounded-md bg-red-700 px-3 py-2 text-sm text-white hover:bg-red-800 disabled:cursor-wait disabled:opacity-60 dark:bg-red-800 dark:hover:bg-red-700"
    >
      {isPending ? 'Retrying…' : 'Retry'}
    </button>
  )
}
