import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LatestBlockSummarySection } from './latest-block-summary-section'

describe('LatestBlockSummarySection', () => {
  it('renders a no-data message when summary is null', () => {
    const html = renderToStaticMarkup(<LatestBlockSummarySection summary={null} />)
    expect(html).toContain('No block runs recorded yet.')
  })

  it('renders block and failure counts when summary is present', () => {
    const html = renderToStaticMarkup(
      <LatestBlockSummarySection
        summary={{
          blockRunId: 'run-1',
          startedAt: new Date('2026-08-04T00:00:00Z'),
          finishedAt: new Date('2026-08-04T00:30:00Z'),
          status: 'completed',
          accountRunCount: 3,
          blockedCount: 5,
          failureCount: 1,
        }}
      />,
    )
    expect(html).toContain('5')
    expect(html).toContain('1')
  })
})
