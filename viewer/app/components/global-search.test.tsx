// @vitest-environment jsdom
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalSearch, buildOperationCycleHref, resolveDisplayState } from './global-search'

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

describe('GlobalSearch AbortController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    )
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('連続して入力すると直前の fetch を abort する', () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort')
    render(<GlobalSearch />)
    const input = screen.getByRole('searchbox')

    fireEvent.change(input, { target: { value: 'al' } })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    fireEvent.change(input, { target: { value: 'ali' } })
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(abortSpy).toHaveBeenCalled()
  })

  it('アンマウント時に処理中の fetch を abort する', () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort')
    const { unmount } = render(<GlobalSearch />)
    const input = screen.getByRole('searchbox')

    fireEvent.change(input, { target: { value: 'al' } })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    unmount()

    expect(abortSpy).toHaveBeenCalled()
  })
})

describe('buildOperationCycleHref', () => {
  it('kindに応じてOperations詳細ページのpathを切り替える', () => {
    expect(buildOperationCycleHref('cycle-1', 'crawl')).toBe('/operations/crawl/cycle-1')
    expect(buildOperationCycleHref('cycle-2', 'weekly_review')).toBe('/operations/review/cycle-2')
    expect(buildOperationCycleHref('cycle-3', 'block')).toBe('/operations/block/cycle-3')
  })
})

const emptyResult = {
  accounts: [],
  labels: [],
  findings: [],
  operations: [],
  timingMs: { accounts: 0, labels: 0, findings: 0, operations: 0 },
}

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
