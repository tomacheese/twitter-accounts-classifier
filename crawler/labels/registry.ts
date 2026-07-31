import { captureException } from '../monitoring/sentry'
import type { AccountFeatureBundle, LabelRule, LabelRuleResult } from './types'

export class LabelRuleRegistry {
  private rules = new Map<string, LabelRule>()

  register(rule: LabelRule): void {
    if (this.rules.has(rule.key)) {
      throw new Error(`Label rule "${rule.key}" is already registered`)
    }
    this.rules.set(rule.key, rule)
  }

  getAll(): LabelRule[] {
    return [...this.rules.values()]
  }

  applyAll(bundle: AccountFeatureBundle): { rule: LabelRule; result: LabelRuleResult }[] {
    return this.getAll().map((rule) => {
      try {
        return { rule, result: rule.evaluate(bundle) }
      } catch (error) {
        captureException(error, { ruleKey: rule.key })
        throw error
      }
    })
  }
}
