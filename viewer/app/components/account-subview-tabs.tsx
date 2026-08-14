'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { formatDateTime } from '@/lib/format-date'
import type {
  AccountClassificationEntryView,
  AccountEvidenceView,
  AccountLabelChangeView,
  AccountRelationView,
  AccountTechnicalView,
  ListAccountRelationsResult,
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

/** 選択中の subview を URL に反映する検索パラメータ名。 */
export const TAB_QUERY_PARAM = 'tab'

/**
 * @param value - 検索パラメータの生の値
 * @returns LAZY_SUBVIEWS のキーであれば true
 */
function isLazySubviewKey(value: string | null): value is LazySubviewKey {
  return !!value && LAZY_SUBVIEWS.some((subview) => subview.key === value)
}

/** subview ごとのレスポンス形状。 */
export interface SubviewDataByKey {
  classification: AccountClassificationEntryView[]
  evidence: AccountEvidenceView[]
  relations: ListAccountRelationsResult
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

const RECENTLY_CHANGED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * @param entries - Classification subview のデータ
 * @returns Active/Recently changed/Remaining false の 3 群
 */
function groupClassificationEntries(entries: AccountClassificationEntryView[]): {
  active: AccountClassificationEntryView[]
  recentlyChanged: AccountClassificationEntryView[]
  remainingFalse: AccountClassificationEntryView[]
} {
  const now = Date.now()
  const active = entries
    .filter((entry) => entry.value)
    .toSorted((a, b) => b.lastChangedAt.getTime() - a.lastChangedAt.getTime())
  const recentlyChanged = entries
    .filter(
      (entry) => !entry.value && now - entry.lastChangedAt.getTime() <= RECENTLY_CHANGED_WINDOW_MS,
    )
    .toSorted((a, b) => b.lastChangedAt.getTime() - a.lastChangedAt.getTime())
  const recentlyChangedKeys = new Set(recentlyChanged.map((entry) => entry.labelKey))
  const remainingFalse = entries.filter(
    (entry) => !entry.value && !recentlyChangedKeys.has(entry.labelKey),
  )
  return { active, recentlyChanged, remainingFalse }
}

/**
 * @param props - 表示する 1 件分の分類結果
 * @returns 描画結果
 */
function ClassificationEntryItem({
  entry,
}: {
  entry: AccountClassificationEntryView
}): React.ReactElement {
  return (
    <li className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <span className="font-medium">{entry.labelKey}</span>{' '}
      <span className="text-gray-500 dark:text-gray-400">
        {entry.value ? 'true' : 'false'} · confidence {entry.confidence.toFixed(2)} · {entry.reason}
      </span>
      <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
        {formatDateTime(entry.lastChangedAt)}
      </p>
    </li>
  )
}

/**
 * @param entries - Classification subview のデータ
 * @returns 描画結果。true のラベルと直近変化した false のラベルを常に表示し、それより古い false のラベルは折り畳む
 */
export function ClassificationView({
  entries,
}: {
  entries: AccountClassificationEntryView[]
}): React.ReactElement {
  if (entries.length === 0) return <EmptyState message="No classification recorded." />
  const { active, recentlyChanged, remainingFalse } = groupClassificationEntries(entries)
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {active.map((entry) => (
          <ClassificationEntryItem key={entry.labelKey} entry={entry} />
        ))}
        {recentlyChanged.map((entry) => (
          <ClassificationEntryItem key={entry.labelKey} entry={entry} />
        ))}
      </ul>
      {remainingFalse.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-gray-500 dark:text-gray-400">
            Remaining false ({remainingFalse.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {remainingFalse.map((entry) => (
              <ClassificationEntryItem key={entry.labelKey} entry={entry} />
            ))}
          </ul>
        </details>
      )}
    </div>
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
 * @param props - 表示する relation・総件数・追加取得の状態
 * @returns 描画結果
 */
export function RelationsView({
  items,
  totalCount,
  hasMore,
  onLoadMore,
  loadingMore,
  loadMoreError = false,
}: {
  items: AccountRelationView[]
  totalCount: number | undefined
  hasMore: boolean
  onLoadMore: () => void
  loadingMore: boolean
  loadMoreError?: boolean
}): React.ReactElement {
  if (items.length === 0 && !hasMore) return <EmptyState message="No block relation recorded." />
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {items.map((entry) => (
          <li
            key={entry.blockId}
            className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <Link
              href={`/accounts/${entry.counterpartAccountId}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {entry.counterpartScreenName}
            </Link>{' '}
            <span className="text-gray-500 dark:text-gray-400">
              {entry.direction} · {entry.status}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {totalCount === undefined
          ? `Showing ${items.length}`
          : `Showing ${items.length} of ${totalCount}`}
      </p>
      {loadMoreError && (
        <p className="text-xs text-red-600 dark:text-red-400">Failed to load more.</p>
      )}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="self-start rounded border px-3 py-1 text-sm text-blue-600 hover:underline disabled:opacity-50 dark:border-gray-700 dark:text-blue-400"
        >
          Load more
        </button>
      )}
    </div>
  )
}

/**
 * @param entries - History subview のデータ
 * @returns 描画結果
 */
export function HistoryView({
  entries,
}: {
  entries: AccountLabelChangeView[]
}): React.ReactElement {
  if (entries.length === 0) return <EmptyState message="No label change recorded." />
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <span className="font-medium">{entry.labelKey}</span>{' '}
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
      <dt className="text-gray-500 dark:text-gray-400">Recent tweets fetch</dt>
      <dd>{data.recentTweetsFetchStatus ?? 'unknown'}</dd>
      <dt className="text-gray-500 dark:text-gray-400">Recent tweets attempted</dt>
      <dd>
        {data.lastRecentTweetsAttemptedAt ? formatDateTime(data.lastRecentTweetsAttemptedAt) : '—'}
      </dd>
      <dt className="text-gray-500 dark:text-gray-400">Recent tweets fetched</dt>
      <dd>
        {data.lastRecentTweetsFetchedAt ? formatDateTime(data.lastRecentTweetsFetchedAt) : '—'}
      </dd>
      <dt className="text-gray-500 dark:text-gray-400">Updated at</dt>
      <dd>{formatDateTime(data.updatedAt)}</dd>
      <dt className="text-gray-500 dark:text-gray-400">Read model freshness</dt>
      <dd>{data.freshnessStatus}</dd>
      <dt className="text-gray-500 dark:text-gray-400">Source watermark</dt>
      <dd>{data.sourceWatermarkAt ? formatDateTime(data.sourceWatermarkAt) : '—'}</dd>
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
  onLoadMoreRelations,
  loadingMoreRelations,
  loadMoreRelationsError,
}: {
  activeTab: LazySubviewKey
  cache: Partial<SubviewDataByKey>
  onLoadMoreRelations: () => void
  loadingMoreRelations: boolean
  loadMoreRelationsError: boolean
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
      return data ? (
        <RelationsView
          items={data.items}
          totalCount={data.totalCount}
          hasMore={data.nextCursor !== null}
          onLoadMore={onLoadMoreRelations}
          loadingMore={loadingMoreRelations}
          loadMoreError={loadMoreRelationsError}
        />
      ) : null
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
 * 選択中のタブは `tab` 検索パラメータに反映し、URL 単体で同じタブを再現できるようにする。
 * @param props - 対象アカウント ID
 * @returns 描画された subview タブ
 */
export function AccountSubviewTabs({ accountId }: AccountSubviewTabsProps): React.ReactElement {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tabFromUrl = searchParams.get(TAB_QUERY_PARAM)
  const initialTab = isLazySubviewKey(tabFromUrl) ? tabFromUrl : null

  const [activeTab, setActiveTab] = useState<LazySubviewKey | null>(initialTab)
  const [cache, setCache] = useState<Partial<SubviewDataByKey>>({})
  const [loadingTab, setLoadingTab] = useState<LazySubviewKey | null>(null)
  const [errorTab, setErrorTab] = useState<LazySubviewKey | null>(null)
  const [loadingMoreRelations, setLoadingMoreRelations] = useState(false)
  const [loadMoreRelationsError, setLoadMoreRelationsError] = useState(false)

  const fetchTab = (tab: LazySubviewKey): void => {
    setLoadingTab(tab)
    setErrorTab(null)
    fetch(buildSubviewUrl(accountId, tab))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unexpected status: ${String(response.status)}`)
        const body = (await response.json()) as { data: SubviewDataByKey[typeof tab] }
        // NextResponse.json() を経由すると Date は ISO 文字列になるため、
        // getTime() を呼ぶ classification だけここで Date に復元する。
        const data =
          tab === 'classification'
            ? (body.data as AccountClassificationEntryView[]).map((entry) => ({
                ...entry,
                lastChangedAt: new Date(entry.lastChangedAt),
              }))
            : body.data
        setCache((previous) => ({ ...previous, [tab]: data }))
      })
      .catch(() => {
        setErrorTab(tab)
      })
      .finally(() => {
        setLoadingTab((current) => (current === tab ? null : current))
      })
  }

  useEffect(() => {
    // マウント時点の URL に有効な tab があれば、そのデータだけ取得する。
    // タブ切り替えは selectTab が個別に処理するため、依存配列は空のままにする。
    if (initialTab) fetchTab(initialTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadMoreRelations = (): void => {
    const current = cache.relations
    if (!current?.nextCursor || loadingMoreRelations) return
    setLoadingMoreRelations(true)
    setLoadMoreRelationsError(false)
    fetch(
      `${buildSubviewUrl(accountId, 'relations')}?cursor=${encodeURIComponent(current.nextCursor)}`,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unexpected status: ${String(response.status)}`)
        const body = (await response.json()) as { data: SubviewDataByKey['relations'] }
        setCache((previous) => {
          const previousRelations = previous.relations
          if (!previousRelations) return previous
          return {
            ...previous,
            relations: {
              items: [...previousRelations.items, ...body.data.items],
              nextCursor: body.data.nextCursor,
              totalCount: body.data.totalCount ?? previousRelations.totalCount,
            },
          }
        })
      })
      .catch(() => {
        setLoadMoreRelationsError(true)
      })
      .finally(() => {
        setLoadingMoreRelations(false)
      })
  }

  const selectTab = (tab: LazySubviewKey): void => {
    setActiveTab(tab)
    router.replace(`${pathname}?${TAB_QUERY_PARAM}=${tab}`, { scroll: false })
    if (tab in cache) return
    fetchTab(tab)
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
        <SubviewContent
          activeTab={activeTab}
          cache={cache}
          onLoadMoreRelations={loadMoreRelations}
          loadingMoreRelations={loadingMoreRelations}
          loadMoreRelationsError={loadMoreRelationsError}
        />
      )}
    </div>
  )
}
