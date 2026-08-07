import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GlobalSearch, resolveDisplayState } from './global-search'

describe('GlobalSearch', () => {
  it('renders an accessible search input', () => {
    const html = renderToStaticMarkup(<GlobalSearch />)
    expect(html).toContain('aria-label="Global search"')
    expect(html).toContain('type="search"')
  })

  it('does not render a results dropdown before any query is entered', () => {
    const html = renderToStaticMarkup(<GlobalSearch />)
    expect(html).not.toContain('No results.')
    expect(html).not.toContain('Searching...')
  })
})

const emptyResult = { accounts: [], labels: [], findings: [], operations: [] }

describe('resolveDisplayState', () => {
  it('検索失敗は空の結果と区別して error になる', () => {
    expect(
      resolveDisplayState({ isLoading: false, error: 'Failed to search.', result: null }),
    ).toBe('error')
  })

  it('結果が 0 件のときだけ empty になる', () => {
    expect(resolveDisplayState({ isLoading: false, error: null, result: emptyResult })).toBe(
      'empty',
    )
    expect(resolveDisplayState({ isLoading: false, error: null, result: null })).toBe('empty')
  })

  it('いずれかの entity type に結果があれば results になる', () => {
    expect(
      resolveDisplayState({
        isLoading: false,
        error: null,
        result: { ...emptyResult, labels: [{ id: 'label-1', key: 'spam' }] },
      }),
    ).toBe('results')
  })

  it('読み込み中は error より先に loading になる', () => {
    expect(resolveDisplayState({ isLoading: true, error: 'Failed to search.', result: null })).toBe(
      'loading',
    )
  })
})
