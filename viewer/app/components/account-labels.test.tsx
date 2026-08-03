import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AccountDetailLabel } from '@/lib/queries/account-detail'
import { AccountLabels } from './account-labels'

function makeLabel(overrides: Partial<AccountDetailLabel> = {}): AccountDetailLabel {
  return {
    labelKey: 'spam',
    value: true,
    confidence: 0.9,
    reason: 'matches keyword',
    method: 'heuristic',
    ruleVersion: '1.0.0',
    labeledAt: new Date('2026-07-01T00:00:00Z'),
    history: [],
    ...overrides,
  }
}

describe('AccountLabels', () => {
  it('renders a placeholder message when there are no labels', () => {
    const html = renderToStaticMarkup(<AccountLabels labels={[]} />)

    expect(html).toContain('No labels recorded for this account.')
  })

  it('always shows applied (value=true) labels expanded', () => {
    const html = renderToStaticMarkup(
      <AccountLabels labels={[makeLabel({ labelKey: 'spam', value: true })]} />,
    )

    expect(html).toContain('spam')
    expect(html).toContain('matches keyword')
    expect(html).not.toContain('<details>')
  })

  it('collapses evaluated-but-inactive (value=false) labels behind a details element', () => {
    const html = renderToStaticMarkup(
      <AccountLabels
        labels={[makeLabel({ labelKey: 'not_spam', value: false, reason: 'no keyword match' })]}
      />,
    )

    expect(html).toContain('<details>')
    expect(html).toContain('評価済みで非該当のラベル (1件)')
    expect(html).toContain('no keyword match')
  })

  it('shows a history toggle only for labels that have history entries', () => {
    const withHistory = makeLabel({
      labelKey: 'spam',
      value: true,
      history: [
        {
          value: false,
          confidence: 0.4,
          reason: 'old reasoning',
          method: 'heuristic',
          ruleVersion: '0.9.0',
          labeledAt: new Date('2026-06-01T00:00:00Z'),
        },
      ],
    })
    const withoutHistory = makeLabel({ labelKey: 'bot', value: true, history: [] })

    const html = renderToStaticMarkup(<AccountLabels labels={[withHistory, withoutHistory]} />)

    expect(html).toContain('履歴 (1件)')
    expect((html.match(/履歴 \(/g) ?? []).length).toBe(1)
    expect(html).toContain('old reasoning')
  })
})
