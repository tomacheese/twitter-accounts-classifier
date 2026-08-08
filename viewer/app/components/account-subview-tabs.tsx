'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { formatDateTime } from '@/lib/format-date'
import type {
  AccountClassificationEntryView,
  AccountEvidenceView,
  AccountLabelChangeView,
  AccountRelationView,
  AccountTechnicalView,
} from '@/lib/queries/account-subviews'

/** タブ切り替えで遅延取得する subview の一覧。 */
export const LAZY_SUBVIEWS = [
  { key: 'classification', label: 'Classification' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'relations', label: 'Relations' },
  { key: 'history', label: 'History' },
  { key: 'technical', label: 'Technical' },
] as const

/** LAZY_SUBVIEWS のキー。 */
export type LazySubviewKey = (typeof LAZY_SUBVIEWS)[number]['key']

/** subview ごとのレスポンス形状。 */
export interface SubviewDataByKey {
  classification: AccountClassificationEntryView[]
  evidence: AccountEvidenceView[]
  relations: AccountRelationView[]
  history: AccountLabelChangeView[]
  technical: AccountTechnicalView
}

/**
 * @param accountId - 対象アカウント ID
 * @param subview - 取得対象の subview
 * @returns `/api/accounts/[accountId]/[subview]` の URL
 */
export function buildSubviewUrl(accountId: string, subview: LazySubviewKey): string {
  return `/api/accounts/${encodeURIComponent(accountId)}/${subview}`
}

/**
 * @param props - 表示するメッセージ
 * @returns 描画結果
 */
function EmptyState({ message }: { message: string }): React.ReactElement {
  return <p className="text-sm text-gray-500 dark:text-gray-400">{message}</p>
}

/**
 * @param entries - Classification subview のデータ
 * @returns 描画結果
 */
function ClassificationView({
  entries,
}: {
  entries: AccountClassificationEntryView[]
}): React.ReactElement {
  if (entries.length === 0) return <EmptyState message="No classification recorded." />
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => (
        <li
          key={entry.labelKey}
          className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <span className="font-medium">{entry.labelKey}</span>{' '}
          <span className="text-gray-500 dark:text-gray-400">
            {entry.value ? 'true' : 'false'} · confidence {entry.confidence.toFixed(2)} ·{' '}
            {entry.reason}
          </span>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            {formatDateTime(entry.lastChangedAt)}
          </p>
        </li>
      ))}
    </ul>
  )
}

/**
 * @param entries - Evidence subview のデータ
 * @returns 描画結果
 */
function EvidenceView({ entries }: { entries: AccountEvidenceView[] }): React.ReactElement {
  if (entries.length === 0) return <EmptyState message="No active finding for this account." />
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => (
        <li
          key={entry.findingId}
          className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <Link
            href={`/review/findings/${entry.findingId}`}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {entry.type}
          </Link>{' '}
          <span className="text-gray-500 dark:text-gray-400">
            {entry.currentSeverity} · {entry.status}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * @param entries - Relations subview のデータ
 * @returns 描画結果
 */
function RelationsView({ entries }: { entries: AccountRelationView[] }): React.ReactElement {
  if (entries.length === 0) return <EmptyState message="No block relation recorded." />
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => (
        <li
          key={entry.blockId}
          className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <Link
            href={`/accounts/${entry.counterpartAccountId}`}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {entry.counterpartAccountId}
          </Link>{' '}
          <span className="text-gray-500 dark:text-gray-400">
            {entry.direction} · {entry.status}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * @param entries - History subview のデータ
 * @returns 描画結果
 */
function HistoryView({ entries }: { entries: AccountLabelChangeView[] }): React.ReactElement {
  if (entries.length === 0) return <EmptyState message="No label change recorded." />
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <span className="font-medium">{entry.labelDefinitionId}</span>{' '}
          <span className="text-gray-500 dark:text-gray-400">
            {entry.changeType}: {String(entry.previousValue)} → {String(entry.newValue)}
          </span>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            {formatDateTime(entry.changedAt)}
          </p>
        </li>
      ))}
    </ul>
  )
}

/**
 * @param data - Technical subview のデータ
 * @returns 描画結果
 */
function TechnicalView({ data }: { data: AccountTechnicalView }): React.ReactElement {
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm">
      <dt className="text-gray-500 dark:text-gray-400">First seen</dt>
      <dd>{formatDateTime(data.firstSeenAt)}</dd>
      <dt className="text-gray-500 dark:text-gray-400">Last crawled</dt>
      <dd>{formatDateTime(data.lastCrawledAt)}</dd>
      <dt className="text-gray-500 dark:text-gray-400">Updated at</dt>
      <dd>{formatDateTime(data.updatedAt)}</dd>
      <dt className="text-gray-500 dark:text-gray-400">Read model generation</dt>
      <dd>{data.generationId ?? '—'}</dd>
    </dl>
  )
}

/**
 * @param props - 現在選択中の subview とキャッシュ済みデータ
 * @returns 描画結果。未取得ならなにも表示しない
 */
function SubviewContent({
  activeTab,
  cache,
}: {
  activeTab: LazySubviewKey
  cache: Partial<SubviewDataByKey>
}): React.ReactElement | null {
  switch (activeTab) {
    case 'classification': {
      const data = cache.classification
      return data ? <ClassificationView entries={data} /> : null
    }
    case 'evidence': {
      const data = cache.evidence
      return data ? <EvidenceView entries={data} /> : null
    }
    case 'relations': {
      const data = cache.relations
      return data ? <RelationsView entries={data} /> : null
    }
    case 'history': {
      const data = cache.history
      return data ? <HistoryView entries={data} /> : null
    }
    case 'technical': {
      const data = cache.technical
      return data ? <TechnicalView data={data} /> : null
    }
  }
}

interface AccountSubviewTabsProps {
  /** 対象アカウント ID。 */
  accountId: string
}

/**
 * Classification/Evidence/Relations/History/Technical は初期表示に含めず、
 * タブを開いたときだけ `/api/accounts/[accountId]/[subview]` から取得する。
 * 一度取得した subview はタブを切り替えても再フェッチしないようキャッシュする。
 * @param props - 対象アカウント ID
 * @returns 描画された subview タブ
 */
export function AccountSubviewTabs({ accountId }: AccountSubviewTabsProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<LazySubviewKey | null>(null)
  const [cache, setCache] = useState<Partial<SubviewDataByKey>>({})
  const [loadingTab, setLoadingTab] = useState<LazySubviewKey | null>(null)
  const [errorTab, setErrorTab] = useState<LazySubviewKey | null>(null)

  const selectTab = (tab: LazySubviewKey): void => {
    setActiveTab(tab)
    if (tab in cache) return

    setLoadingTab(tab)
    setErrorTab(null)
    fetch(buildSubviewUrl(accountId, tab))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unexpected status: ${String(response.status)}`)
        const body = (await response.json()) as { data: SubviewDataByKey[typeof tab] }
        setCache((previous) => ({ ...previous, [tab]: body.data }))
      })
      .catch(() => {
        setErrorTab(tab)
      })
      .finally(() => {
        setLoadingTab((current) => (current === tab ? null : current))
      })
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Account detail sections"
        className="flex flex-wrap gap-2 border-b dark:border-gray-700"
      >
        {LAZY_SUBVIEWS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            onClick={() => {
              selectTab(tab.key)
            }}
            className={`px-3 py-2 text-sm font-medium ${
              activeTab === tab.key
                ? 'border-b-2 border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab && loadingTab === activeTab && (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      )}
      {activeTab && errorTab === activeTab && (
        <p className="text-sm text-red-600 dark:text-red-400">Failed to load this section.</p>
      )}
      {activeTab && loadingTab !== activeTab && errorTab !== activeTab && (
        <SubviewContent activeTab={activeTab} cache={cache} />
      )}
    </div>
  )
}
