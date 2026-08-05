import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SystemStatusEntry } from '@/lib/queries/system-status'
import { SystemStatusSection } from './system-status-section'

function entry(overrides: Partial<SystemStatusEntry> = {}): SystemStatusEntry {
  return {
    service: 'crawler',
    healthStatus: 'healthy',
    rawStatus: 'success',
    startedAt: new Date('2026-08-04T00:00:00Z'),
    finishedAt: new Date('2026-08-04T01:00:00Z'),
    lastSuccessAt: new Date('2026-08-04T01:00:00Z'),
    lastDurationMs: 60 * 60 * 1000,
    errorMessage: null,
    detailHref: '/crawl-runs',
    ...overrides,
  }
}

describe('SystemStatusSection', () => {
  it('renders a badge and detail link for each service', () => {
    const html = renderToStaticMarkup(
      <SystemStatusSection
        entries={[entry(), entry({ service: 'blocker', detailHref: '/block-runs' })]}
      />,
    )

    expect(html).toContain('healthy')
    expect(html).toContain('/crawl-runs')
    expect(html).toContain('/block-runs')
  })

  it('renders the error message when present', () => {
    const html = renderToStaticMarkup(
      <SystemStatusSection
        entries={[
          entry({
            service: 'weekly_analysis',
            healthStatus: 'failed',
            rawStatus: 'failed',
            errorMessage: 'Example failure for a fictional run.',
            detailHref: '/weekly-runs',
          }),
        ]}
      />,
    )

    expect(html).toContain('Example failure for a fictional run.')
  })
})
