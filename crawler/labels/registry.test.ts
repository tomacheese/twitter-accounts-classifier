import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LabelRuleRegistry } from './registry'
import type { AccountFeatureBundle, LabelRule } from './types'

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }))
vi.mock('../monitoring/sentry', () => ({ captureException: captureExceptionMock }))

const bundle: AccountFeatureBundle = {
  account: {
    id: '1',
    screenName: 'someone',
    displayName: 'Someone',
    bio: null,
    followersCount: 1,
    followingCount: 1,
    tweetCount: 1,
    accountCreatedAt: new Date(),
    isBlueVerified: false,
    verifiedType: null,
  },
  recentTweets: [],
}

const alwaysTrueRule: LabelRule = {
  key: 'always_true',
  description: 'test rule',
  version: '1.0.0',
  evaluate: () => ({ value: true, confidence: 1, reason: 'always true' }),
}

describe('LabelRuleRegistry', () => {
  beforeEach(() => {
    captureExceptionMock.mockClear()
  })

  it('applies every registered rule to the bundle', () => {
    const registry = new LabelRuleRegistry()
    registry.register(alwaysTrueRule)

    const results = registry.applyAll(bundle)

    expect(results).toHaveLength(1)
    expect(results[0].rule.key).toBe('always_true')
    expect(results[0].result.value).toBe(true)
  })

  it('rejects registering the same key twice', () => {
    const registry = new LabelRuleRegistry()
    registry.register(alwaysTrueRule)

    expect(() => {
      registry.register(alwaysTrueRule)
    }).toThrow(/already registered/)
  })

  it('captures rule evaluation exceptions and rethrows', () => {
    const throwingRule: LabelRule = {
      key: 'throwing',
      description: 'test rule',
      version: '1.0.0',
      evaluate: () => {
        throw new Error('rule blew up')
      },
    }
    const registry = new LabelRuleRegistry()
    registry.register(throwingRule)

    expect(() => registry.applyAll(bundle)).toThrow('rule blew up')
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), { ruleKey: 'throwing' })
  })
})
