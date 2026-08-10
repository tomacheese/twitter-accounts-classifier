// @vitest-environment jsdom
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AccountClassificationEntryView,
  AccountLabelChangeView,
} from '@/lib/queries/account-subviews'

const { useRouterMock, usePathnameMock, useSearchParamsMock } = vi.hoisted(() => ({
  useRouterMock: vi.fn(() => ({ replace: vi.fn() })),
  usePathnameMock: vi.fn(() => '/accounts/account-1'),
  useSearchParamsMock: vi.fn(() => new URLSearchParams()),
}))

vi.mock('next/navigation', () => ({
  useRouter: useRouterMock,
  usePathname: usePathnameMock,
  useSearchParams: useSearchParamsMock,
}))

const {
  AccountSubviewTabs,
  buildSubviewUrl,
  ClassificationView,
  HistoryView,
  RelationsView,
  TAB_QUERY_PARAM,
} = await import('./account-subview-tabs')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('buildSubviewUrl', () => {
  it('accountId と subview から Route Handler の URL を組み立てる', () => {
    expect(buildSubviewUrl('account-1', 'classification')).toBe(
      '/api/accounts/account-1/classification',
    )
  })

  it('accountId を URL エンコードする', () => {
    expect(buildSubviewUrl('a/b', 'technical')).toBe('/api/accounts/a%2Fb/technical')
  })
})

describe('AccountSubviewTabs', () => {
  it('tab 検索パラメータが無ければ、5 つの subview タブだけを描画し内容は取得しない', () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams())

    const html = renderToStaticMarkup(<AccountSubviewTabs accountId="account-1" />)
    expect(html).toContain('Classification')
    expect(html).toContain('Evidence')
    expect(html).toContain('Relations')
    expect(html).toContain('History')
    expect(html).toContain('Technical')
    expect(html).not.toContain('Loading…')
  })

  it('URL の tab 検索パラメータが指す subview を選択済みとして描画する', () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams(`${TAB_QUERY_PARAM}=history`))

    const html = renderToStaticMarkup(<AccountSubviewTabs accountId="account-1" />)

    expect(html).toContain('aria-selected="true"')
    const historyButtonIndex = html.indexOf('History')
    const precedingMarkup = html.slice(0, historyButtonIndex)
    const lastTabStart = precedingMarkup.lastIndexOf('role="tab"')
    expect(precedingMarkup.slice(lastTabStart)).toContain('aria-selected="true"')
  })

  it('未知の tab 検索パラメータは無視し、どのタブも選択済みにしない', () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams(`${TAB_QUERY_PARAM}=unknown`))

    const html = renderToStaticMarkup(<AccountSubviewTabs accountId="account-1" />)

    expect(html).not.toContain('aria-selected="true"')
  })
})

describe('AccountSubviewTabs (classification タブの取得)', () => {
  it('fetch が返す ISO 文字列の lastChangedAt を Date として扱い、例外なく描画する', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams())
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          data: [
            {
              labelKey: 'active_1',
              value: true,
              confidence: 0.9,
              reason: 'x',
              lastChangedAt: '2026-08-09T00:00:00.000Z',
            },
            {
              labelKey: 'old_false',
              value: false,
              confidence: 0.5,
              reason: 'x',
              lastChangedAt: '2026-08-01T00:00:00.000Z',
            },
          ],
        }),
      }),
    )

    render(<AccountSubviewTabs accountId="account-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Classification' }))

    await waitFor(() => {
      expect(screen.getByText('active_1')).not.toBeNull()
    })
    expect(screen.queryByText('Failed to load this section.')).toBeNull()
  })
})

describe('AccountSubviewTabs (technical タブの取得)', () => {
  it('freshnessStatus と sourceWatermarkAt を表示する', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams())
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          data: {
            accountId: 'account-1',
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastCrawledAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-03T00:00:00.000Z',
            freshnessStatus: 'healthy',
            sourceWatermarkAt: '2026-01-04T00:00:00.000Z',
          },
        }),
      }),
    )

    render(<AccountSubviewTabs accountId="account-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Technical' }))

    await waitFor(() => {
      expect(screen.getByText('healthy')).not.toBeNull()
    })
  })
})

describe('ClassificationView', () => {
  it('Active → Recently changed (7 日以内) → Remaining false の順に表示する', () => {
    const now = new Date('2026-08-09T00:00:00.000Z')
    vi.useFakeTimers().setSystemTime(now)
    const RECENTLY_CHANGED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
    const entries: AccountClassificationEntryView[] = [
      {
        labelKey: 'old_false',
        value: false,
        confidence: 0.5,
        reason: 'x',
        lastChangedAt: new Date(now.getTime() - RECENTLY_CHANGED_WINDOW_MS - 1000),
      },
      {
        labelKey: 'recent_false',
        value: false,
        confidence: 0.5,
        reason: 'x',
        lastChangedAt: new Date(now.getTime() - 1000),
      },
      {
        labelKey: 'active_1',
        value: true,
        confidence: 0.9,
        reason: 'x',
        lastChangedAt: new Date(now.getTime() - 2000),
      },
    ]

    render(<ClassificationView entries={entries} />)
    vi.useRealTimers()

    const items = screen.getAllByRole('listitem').map((el) => el.textContent)
    expect(items[0]).toContain('active_1')
    expect(items[1]).toContain('recent_false')
    // Remaining false (old_false) は <details> で折り畳まれているため既定では閉じている
    const oldFalseText = screen.getByText(/old_false/)
    expect(oldFalseText.closest('details')?.hasAttribute('open')).toBe(false)
  })

  it('各群内では lastChangedAt の降順（新しいものが先）に並べる', () => {
    const now = new Date('2026-08-09T00:00:00.000Z')
    vi.useFakeTimers().setSystemTime(now)
    const entries: AccountClassificationEntryView[] = [
      {
        labelKey: 'active_older',
        value: true,
        confidence: 0.9,
        reason: 'x',
        lastChangedAt: new Date(now.getTime() - 5000),
      },
      {
        labelKey: 'active_newer',
        value: true,
        confidence: 0.9,
        reason: 'x',
        lastChangedAt: new Date(now.getTime() - 1000),
      },
      {
        labelKey: 'recent_older',
        value: false,
        confidence: 0.5,
        reason: 'x',
        lastChangedAt: new Date(now.getTime() - 4000),
      },
      {
        labelKey: 'recent_newer',
        value: false,
        confidence: 0.5,
        reason: 'x',
        lastChangedAt: new Date(now.getTime() - 2000),
      },
    ]

    render(<ClassificationView entries={entries} />)
    vi.useRealTimers()

    const items = screen.getAllByRole('listitem').map((el) => el.textContent)
    expect(items[0]).toContain('active_newer')
    expect(items[1]).toContain('active_older')
    expect(items[2]).toContain('recent_newer')
    expect(items[3]).toContain('recent_older')
  })
})

describe('HistoryView', () => {
  it('labelKey を表示する', () => {
    const entries: AccountLabelChangeView[] = [
      {
        id: 'change-1',
        labelKey: 'spam',
        changeType: 'updated',
        previousValue: false,
        newValue: true,
        changedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]

    render(<HistoryView entries={entries} />)

    expect(screen.getByText('spam')).not.toBeNull()
  })
})

describe('RelationsView', () => {
  it('counterpartScreenName をリンク文字列に表示し、リンク先は counterpartAccountId のままにする', () => {
    render(
      <RelationsView
        items={[
          {
            blockId: 'block-1',
            direction: 'blocker',
            counterpartAccountId: 'account-2',
            counterpartScreenName: 'bob',
            status: 'active',
          },
        ]}
        totalCount={1}
        hasMore={false}
        onLoadMore={vi.fn()}
        loadingMore={false}
      />,
    )

    const link = screen.getByRole('link', { name: 'bob' })
    expect(link.getAttribute('href')).toBe('/accounts/account-2')
  })

  it('表示中件数と総件数を表示する', () => {
    render(
      <RelationsView
        items={[
          {
            blockId: 'block-1',
            direction: 'blocker',
            counterpartAccountId: 'account-2',
            counterpartScreenName: 'bob',
            status: 'active',
          },
        ]}
        totalCount={2005}
        hasMore={true}
        onLoadMore={vi.fn()}
        loadingMore={false}
      />,
    )

    expect(screen.getByText(/1.*2005/)).not.toBeNull()
  })

  it('hasMore が true の間だけ Load more ボタンを表示する', () => {
    const { rerender } = render(
      <RelationsView
        items={[]}
        totalCount={0}
        hasMore={true}
        onLoadMore={vi.fn()}
        loadingMore={false}
      />,
    )
    expect(screen.getByRole('button', { name: 'Load more' })).not.toBeNull()

    rerender(
      <RelationsView
        items={[]}
        totalCount={0}
        hasMore={false}
        onLoadMore={vi.fn()}
        loadingMore={false}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('Load more ボタンをクリックすると onLoadMore を呼ぶ', () => {
    const onLoadMore = vi.fn()
    render(
      <RelationsView
        items={[]}
        totalCount={0}
        hasMore={true}
        onLoadMore={onLoadMore}
        loadingMore={false}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })
})

describe('AccountSubviewTabs (relations タブの追加取得)', () => {
  it('Load more をクリックすると次ページを取得して既存 items に連結する', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams())
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => ({
          data: {
            items: [
              {
                blockId: 'block-1',
                direction: 'blocker',
                counterpartAccountId: 'account-2',
                counterpartScreenName: 'bob',
                status: 'active',
              },
            ],
            nextCursor: 'cursor-1',
            totalCount: 2,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => ({
          data: {
            items: [
              {
                blockId: 'block-2',
                direction: 'blocked',
                counterpartAccountId: 'account-3',
                counterpartScreenName: 'carol',
                status: 'active',
              },
            ],
            nextCursor: null,
            totalCount: 2,
          },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    render(<AccountSubviewTabs accountId="account-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Relations' }))

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'bob' })).not.toBeNull()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'carol' })).not.toBeNull()
    })
    expect(screen.getByRole('link', { name: 'bob' })).not.toBeNull()
    expect(fetchMock.mock.calls[1][0]).toContain('cursor=cursor-1')
  })
})
