// @vitest-environment jsdom
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AccountClassificationEntryView,
  AccountLabelChangeView,
  AccountRelationView,
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

describe('ClassificationView', () => {
  it('Active → Recently changed (7日以内) → Remaining false の順に表示する', () => {
    const now = new Date('2026-08-09T00:00:00.000Z')
    vi.setSystemTime(now)
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
    const entries: AccountRelationView[] = [
      {
        blockId: 'block-1',
        direction: 'blocker',
        counterpartAccountId: 'account-2',
        counterpartScreenName: 'bob',
        status: 'active',
      },
    ]

    render(<RelationsView entries={entries} />)

    const link = screen.getByRole('link', { name: 'bob' })
    expect(link.getAttribute('href')).toBe('/accounts/account-2')
  })
})
