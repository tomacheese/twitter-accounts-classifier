import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LabelOverviewSection } from './label-overview-section'

describe('LabelOverviewSection', () => {
  it('renders each label entry via the shared distribution chart', () => {
    const html = renderToStaticMarkup(
      <LabelOverviewSection
        entries={[
          {
            labelKey: 'blue_verified',
            labelDescription: 'Verified',
            trueCount: 20,
            totalAccounts: 100,
          },
        ]}
      />,
    )
    expect(html).toContain('blue_verified')
  })
})
