import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AttentionItem } from '@/lib/queries/attention-required'
import { AttentionRequiredSection } from './attention-required-section'

describe('AttentionRequiredSection', () => {
  it('renders a message indicating nothing needs attention when the list is empty', () => {
    const html = renderToStaticMarkup(<AttentionRequiredSection items={[]} />)
    expect(html).toContain('Nothing needs attention right now.')
  })

  it('renders each item with its message and link', () => {
    const items: AttentionItem[] = [
      {
        kind: 'stale_run',
        service: 'crawler',
        message: 'Example stale crawl run message.',
        occurredAt: new Date('2026-08-05T00:00:00Z'),
        href: '/crawl-runs/run1',
      },
    ]
    const html = renderToStaticMarkup(<AttentionRequiredSection items={items} />)

    expect(html).toContain('Example stale crawl run message.')
    expect(html).toContain('/crawl-runs/run1')
  })

  it('renders multiple items in the given order', () => {
    const items: AttentionItem[] = [
      {
        kind: 'block_failure',
        service: 'blocker',
        message: 'Example newer block failure message.',
        occurredAt: new Date('2026-08-05T00:00:00Z'),
        href: '/block-runs/run-new',
      },
      {
        kind: 'failed_run',
        service: 'blocker',
        message: 'Example older failed run message.',
        occurredAt: new Date('2026-08-01T00:00:00Z'),
        href: '/block-runs/run-old',
      },
    ]
    const html = renderToStaticMarkup(<AttentionRequiredSection items={items} />)

    expect(html.indexOf('Example newer block failure message.')).toBeLessThan(
      html.indexOf('Example older failed run message.'),
    )
  })
})
