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

  it('is false for an illustrator bio that rejects unauthorized NFT-ification, not declaring interest', () => {
    expect(
      topicCryptoRule.evaluate(
        makeBundle({ bio: 'イラスト垢です。🚫NFT/AI学習🚫 無断転載もお断り' }),
      ).value,
    ).toBe(false)
  })

  it('is true for a bio with an early rejected NFT mention followed by a later, well-separated genuine crypto declaration', () => {
    expect(
      topicCryptoRule.evaluate(
        makeBundle({
          bio: 'イラスト垢です。🚫NFT/AI学習🚫 無断転載もお断り。猫と旅行が好きです。趣味の投資としてビットコインも少し保有しています',
        }),
      ).value,
    ).toBe(true)
  })

  it('is false for a bio that rejects crypto with an English "NO" disclaimer', () => {
    expect(
      topicCryptoRule.evaluate(makeBundle({ bio: 'NO POLITICS / NO CRYPTO / cat photos daily' }))
        .value,
    ).toBe(false)
  })

  it('is true for a crypto bio where an unrelated word merely contains "ng" near the keyword (not a real rejection marker)', () => {
    expect(
      topicCryptoRule.evaluate(makeBundle({ bio: 'crypto trader, posting charts every morning' }))
        .value,
    ).toBe(true)
  })

  it('bio・ツイートにキーワードを含まず、フォローグラフシグナルがしきい値を満たす場合は value: true・confidence が 0.5 超になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_crypto: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicCryptoRule.evaluate(bundle)
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('フォローグラフシグナルがしきい値未満の場合は value: false のままになる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_crypto: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicCryptoRule.evaluate(bundle)
    expect(result.value).toBe(false)
  })
  it('bio が無くフォローグラフのサンプルも不足している場合、evaluable: false・confidence: 0.5 になる', () => {
    const bundle = {
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_crypto: {
          followeeLabeledCount: 1,
          followeeTotalCount: 3,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicCryptoRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('bio があればフォローグラフのサンプルが不足していても evaluable: true になる', () => {
    const result = topicCryptoRule.evaluate(makeBundle({ bio: '日常アカウントです' }))
    expect(result.evaluable).toBe(true)
  })
})
