import { describe, expect, it } from 'vitest'
import { topicCryptoRule } from './topic-crypto'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  accountOverrides: Partial<AccountFeatureBundle['account']>,
): AccountFeatureBundle {
  return {
    account: {
      id: '1',
      screenName: 'x',
      displayName: 'X',
      bio: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      isBlueVerified: false,
      verifiedType: null,
      ...accountOverrides,
    },
    recentTweets: [],
  }
}

describe('topicCryptoRule', () => {
  it('is true for a crypto/airdrop bio', () => {
    expect(
      topicCryptoRule.evaluate(makeBundle({ bio: '仮想通貨エアドロハンター #Airdrop #Crypto' }))
        .value,
    ).toBe(true)
  })

  it('is true for an English crypto bio', () => {
    expect(
      topicCryptoRule.evaluate(makeBundle({ bio: 'NFT collector & web3 builder' })).value,
    ).toBe(true)
  })

  it('is false for an unrelated bio', () => {
    expect(
      topicCryptoRule.evaluate(makeBundle({ bio: '毎日ラーメンの写真を載せています' })).value,
    ).toBe(false)
  })

  it('is false for a bio containing "cryptography" (not a word-boundary match for "crypto")', () => {
    expect(
      topicCryptoRule.evaluate(makeBundle({ bio: 'Cryptography researcher, security nerd' })).value,
    ).toBe(false)
  })
})
