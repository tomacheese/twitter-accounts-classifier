import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountSubviewTabs, buildSubviewUrl } from './account-subview-tabs'

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
  it('初期表示では 5 つの subview タブだけを描画し、内容は取得しない', () => {
    const html = renderToStaticMarkup(<AccountSubviewTabs accountId="account-1" />)
    expect(html).toContain('Classification')
    expect(html).toContain('Evidence')
    expect(html).toContain('Relations')
    expect(html).toContain('History')
    expect(html).toContain('Technical')
    expect(html).not.toContain('Loading…')
  })
})
