import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

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

const { AccountSubviewTabs, buildSubviewUrl, TAB_QUERY_PARAM } =
  await import('./account-subview-tabs')

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
