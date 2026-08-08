import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReadModelReadinessPanel } from './read-model-readiness-panel'

describe('ReadModelReadinessPanel', () => {
  it('renders a bootstrapping message', () => {
    const html = renderToStaticMarkup(
      <ReadModelReadinessPanel status="bootstrapping" section="Accounts" />,
    )
    expect(html).toContain('still being built')
  })

  it('renders a failed message', () => {
    const html = renderToStaticMarkup(<ReadModelReadinessPanel status="failed" section="Labels" />)
    expect(html).toContain('failed to build')
  })
})
