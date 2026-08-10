import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from './status-badge'

describe('StatusBadge', () => {
  it('converts an internal snake_case status into a human-readable label', () => {
    const html = renderToStaticMarkup(<StatusBadge status="not_run" />)
    expect(html).toContain('Not run')
    expect(html).not.toContain('not_run')
  })

  it('renders skipped as a human-readable neutral status', () => {
    const html = renderToStaticMarkup(<StatusBadge status="skipped" />)
    expect(html).toContain('Skipped')
    expect(html).toContain('bg-gray-100')
  })

  it('falls back to the raw value for an unrecognized status', () => {
    const html = renderToStaticMarkup(<StatusBadge status="something_else" />)
    expect(html).toContain('something_else')
  })
})
