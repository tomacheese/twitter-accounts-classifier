import { describe, expect, it } from 'vitest'
import { selfReplyPromoChainRule } from './self-reply-promo-chain'
import type { AccountFeatureBundle } from '../types'
import type { SelfReplyPromoEvidence } from '../self-reply-promo-index'

function makeBundle(evidence: SelfReplyPromoEvidence | undefined): AccountFeatureBundle {
  return {
    account: {
      id: '1',
      screenName: 'alice',
      displayName: 'Alice',
      bio: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      isBlueVerified: false,
      verifiedType: null,
    },
    recentTweets: [],
    selfReplyPromoEvidence: evidence,
  }
}

describe('selfReplyPromoChainRule', () => {
  it('is true when exactDestinationRoots reaches the Route A threshold', () => {
    const result = selfReplyPromoChainRule.evaluate(
      makeBundle({ promoRoots: 3, exactDestinationRoots: 3, multiHopRoots: 0, maxChainDepth: 1 }),
    )

    expect(result.value).toBe(true)
    expect(result.evaluable).toBe(true)
  })

  it('is true when multiHopRoots reaches the Route B threshold even with rotating destinations', () => {
    const result = selfReplyPromoChainRule.evaluate(
      makeBundle({ promoRoots: 3, exactDestinationRoots: 1, multiHopRoots: 3, maxChainDepth: 2 }),
    )

    expect(result.value).toBe(true)
  })

  it('is false and not evaluable when neither route reaches the threshold', () => {
    const result = selfReplyPromoChainRule.evaluate(
      makeBundle({ promoRoots: 2, exactDestinationRoots: 2, multiHopRoots: 1, maxChainDepth: 1 }),
    )

    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0.5)
    expect(result.evaluable).toBe(false)
  })

  it('is false and not evaluable when there is no evidence at all', () => {
    const result = selfReplyPromoChainRule.evaluate(makeBundle(undefined))

    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0.5)
    expect(result.evaluable).toBe(false)
  })

  it('increases confidence as promoRoots grows, independent of chain depth', () => {
    const floor = selfReplyPromoChainRule.evaluate(
      makeBundle({ promoRoots: 3, exactDestinationRoots: 3, multiHopRoots: 0, maxChainDepth: 1 }),
    )
    const strong = selfReplyPromoChainRule.evaluate(
      makeBundle({ promoRoots: 4, exactDestinationRoots: 4, multiHopRoots: 0, maxChainDepth: 1 }),
    )
    const veryStrong = selfReplyPromoChainRule.evaluate(
      makeBundle({ promoRoots: 5, exactDestinationRoots: 5, multiHopRoots: 0, maxChainDepth: 1 }),
    )
    // depth だけが異なり promoRoots は floor と同じケース: confidence は変わらない。
    const deepButSameRoots = selfReplyPromoChainRule.evaluate(
      makeBundle({ promoRoots: 3, exactDestinationRoots: 3, multiHopRoots: 0, maxChainDepth: 6 }),
    )

    expect(strong.confidence).toBeGreaterThan(floor.confidence)
    expect(veryStrong.confidence).toBeGreaterThan(strong.confidence)
    expect(deepButSameRoots.confidence).toBe(floor.confidence)
  })

  it('includes promoRoots/exactDestinationRoots/multiHopRoots/maxDepth in the reason string', () => {
    const result = selfReplyPromoChainRule.evaluate(
      makeBundle({ promoRoots: 4, exactDestinationRoots: 4, multiHopRoots: 1, maxChainDepth: 3 }),
    )

    expect(result.reason).toBe(
      'promoRoots=4, exactDestinationRoots=4, multiHopRoots=1, maxDepth=3',
    )
  })
})
