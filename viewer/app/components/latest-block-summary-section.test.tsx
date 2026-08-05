import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LatestBlockSummarySection } from './latest-block-summary-section'

describe('LatestBlockSummarySection', () => {
  it('renders a no-data message when summary is null', () => {
    const html = renderToStaticMarkup(<LatestBlockSummarySection summary={null} />)
    expect(html).toContain('No block runs recorded yet.')
  })

  it('renders candidate, block, failure counts, and last success time when summary is present', () => {
    const html = renderToStaticMarkup(
      <LatestBlockSummarySection
        summary={{
          blockRunId: 'run-1',
          startedAt: new Date('2026-08-04T00:00:00Z'),
          finishedAt: new Date('2026-08-04T00:30:00Z'),
          status: 'completed',
          accountRunCount: 3,
          candidatesCount: 9,
          blockedCount: 5,
          failureCount: 1,
          lastSuccessAt: new Date('2026-08-04T00:30:00Z'),
        }}
      />,
    )
    expect(html).toContain('9')
    expect(html).toContain('5')
    expect(html).toContain('1')
    expect(html).toContain('Last success')
  })

  it('renders a placeholder when the block run has never succeeded', () => {
    const html = renderToStaticMarkup(
      <LatestBlockSummarySection
        summary={{
          blockRunId: 'run-1',
          startedAt: new Date('2026-08-04T00:00:00Z'),
          finishedAt: new Date('2026-08-04T00:30:00Z'),
          status: 'failed',
          accountRunCount: 0,
          candidatesCount: 0,
          blockedCount: 0,
          failureCount: 0,
          lastSuccessAt: null,
        }}
      />,
    )
    expect(html).toContain('—')
  })
})
