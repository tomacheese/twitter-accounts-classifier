import React from 'react'
import type { ReadModelReadinessStatus } from '@/lib/read-model-meta'

const MESSAGES: Record<Exclude<ReadModelReadinessStatus, 'ready'>, string> = {
  bootstrapping:
    'is still being built from existing data. This may take a while for large datasets.',
  failed: 'failed to build. Check the analyzer logs for details.',
  unavailable: 'has no data available yet.',
}

/**
 * read model が ready でない場合に表示する専用パネル。
 * 0 件表示 (No accounts to show yet 等) と区別し、bootstrap 進行中・失敗・
 * データ不在のどの状態かを明示する。
 * @param props - 対象セクション名と readiness
 * @returns 状態ごとの案内パネル
 */
export function ReadModelReadinessPanel({
  status,
  section,
}: {
  status: Exclude<ReadModelReadinessStatus, 'ready'>
  section: string
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-100">
      {section} {MESSAGES[status]}
    </div>
  )
}
