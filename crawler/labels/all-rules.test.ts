import { describe, expect, it } from 'vitest'
import { ALL_LABEL_RULES } from './all-rules'
import { LabelRuleRegistry } from './registry'
import { scamLinkDomainRule } from './rules/scam-link-domain'

describe('ALL_LABEL_RULES', () => {
  it('contains only rules with unique keys', () => {
    const registry = new LabelRuleRegistry()
    expect(() => {
      for (const rule of ALL_LABEL_RULES) registry.register(rule)
    }).not.toThrow()
    expect(registry.getAll()).toHaveLength(ALL_LABEL_RULES.length)
  })

  it('includes scamLinkDomainRule', () => {
    expect(ALL_LABEL_RULES).toContain(scamLinkDomainRule)
  })
})
