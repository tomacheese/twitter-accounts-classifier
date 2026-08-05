import Link from 'next/link'
import React from 'react'
import { formatDateTime } from '@/lib/format-date'
import type { AttentionItem } from '@/lib/queries/attention-required'

/**
 * @param props - 対応が必要な項目一覧 (新しい順)
 * @returns 描画された対応が必要な項目セクション
 */
export function AttentionRequiredSection({
  items,
}: {
  items: AttentionItem[]
}): React.ReactElement {
  return (
    <section>
      <h2 className="text-lg font-semibold">Attention required</h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Nothing needs attention right now.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {items.map((item, index) => (
            <li
              key={`${item.service}-${item.kind}-${index}`}
              className="rounded border p-3 text-sm dark:border-gray-700"
            >
              <span className="mr-2 text-gray-500 dark:text-gray-400">
                {formatDateTime(item.occurredAt)}
              </span>
              <span>{item.message}</span>
              <Link href={item.href} className="ml-2 text-blue-600 underline dark:text-blue-400">
                View
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
