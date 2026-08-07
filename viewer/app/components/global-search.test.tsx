import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GlobalSearch } from './global-search'

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
