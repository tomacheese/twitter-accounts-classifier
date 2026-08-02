import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DetailLoading, TableLoading } from './route-loading'

describe('TableLoading', () => {
  it('renders an accessible loading state and the page heading', () => {
    const html = renderToStaticMarkup(<TableLoading title="Accounts" columnCount={3} />)

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<h1 class="text-2xl font-semibold">Accounts</h1>')
  })
})

describe('DetailLoading', () => {
  it('renders an accessible loading state and a page heading', () => {
    const html = renderToStaticMarkup(<DetailLoading title="Account" sectionCount={2} />)

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<h1 class="sr-only">Account</h1>')
  })
})
