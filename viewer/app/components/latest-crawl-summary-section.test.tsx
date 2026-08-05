import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LatestCrawlSummarySection } from './latest-crawl-summary-section'

describe('LatestCrawlSummarySection', () => {
  it('renders a no-data message when summary is null', () => {
    const html = renderToStaticMarkup(<LatestCrawlSummarySection summary={null} />)
    expect(html).toContain('No crawl runs recorded yet.')
  })

  it('renders account counts when summary is present', () => {
    const html = renderToStaticMarkup(
      <LatestCrawlSummarySection
        summary={{
          crawlRunId: 'run1',
          startedAt: new Date('2026-08-04T00:00:00Z'),
          finishedAt: new Date('2026-08-04T01:00:00Z'),
          status: 'success',
          accountCount: 10,
          successCount: 9,
          partialOrFailedCount: 1,
        }}
      />,
    )
    expect(html).toContain('10')
    expect(html).toContain('9')
  })
})
