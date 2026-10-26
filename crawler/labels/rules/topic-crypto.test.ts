import { describe, expect, it } from 'vitest'
import { topicCryptoRule } from './topic-crypto'
import type { AccountFeatureBundle } from '../types'

function makeTweet(fullText: string): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: 't1',
    fullText,
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply: false,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
  }
}

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

  it('is true for a bio affirming NFTs where an unrelated "not" merely happens to sit nearby ("NFTs are not going anywhere")', () => {
    expect(
      topicCryptoRule.evaluate(makeBundle({ bio: 'NFTs are not going anywhere, huge fan here' }))
        .value,
    ).toBe(true)
  })

  it('フォローグラフシグナルだけでは value: false のままになる', () => {
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
    expect(result.value).toBe(false)
  })

  it('フォローグラフシグナルが直近投稿のキーワードと併用される場合は value: true・confidence が 0.5 超になる', () => {
    const bundle = {
      ...makeBundle({}),
      recentTweets: [makeTweet('今日のビットコインの値動きをまとめました')],
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

  it('フォローグラフシグナルが満たされても直近投稿の語が拒否文脈なら value: false になる', () => {
    const bundle = {
      ...makeBundle({}),
      recentTweets: [makeTweet('NFT 化は禁止です')],
      followGraphLabelSignals: {
        topic_crypto: {
          followeeLabeledCount: 5,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    expect(topicCryptoRule.evaluate(bundle).value).toBe(false)
  })

  it('直近投稿のキーワードだけでフォローグラフシグナルが無い場合は value: false になる', () => {
    const bundle = {
      ...makeBundle({ bio: '日常アカウントです' }),
      recentTweets: [makeTweet('ビットコインが上がった')],
    }
    expect(topicCryptoRule.evaluate(bundle).value).toBe(false)
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

  it.each([
    'No BitCoin or Crypto. Politics and local news only.',
    'NG: NFT and crypto and blockchain. Illustrator.',
    'No NFT / Crypto / Web3 talk here',
  ])('is false for a bio rejecting a whole list of crypto terms (%s)', (bio) => {
    expect(topicCryptoRule.evaluate(makeBundle({ bio })).value).toBe(false)
  })

  it.each([
    'Linux admin, nftables and firewall notes',
    'Cryptozoology fan and cryptology student',
    'Front-end dev using web3js samples',
  ])('is false for a bio whose word merely starts with a crypto term (%s)', (bio) => {
    expect(topicCryptoRule.evaluate(makeBundle({ bio })).value).toBe(false)
  })

  it('is true for a bio listing crypto after an unrelated negation', () => {
    expect(
      topicCryptoRule.evaluate(makeBundle({ bio: 'No spam please. Bitcoin and NFT collector.' }))
        .value,
    ).toBe(true)
  })

  it.each([
    [6, 20, true],
    [5, 20, false],
    [5, 15, true],
    [4, 15, false],
  ])(
    'follow graph with a tweet keyword boundary: %i labeled of %i followees gives value=%s',
    (labeled, total, expected) => {
      const bundle = {
        ...makeBundle({}),
        recentTweets: [makeTweet('ビットコインの話')],
        followGraphLabelSignals: {
          topic_crypto: {
            followeeLabeledCount: labeled,
            followeeTotalCount: total,
            followerLabeledCount: 0,
            followerTotalCount: 0,
          },
        },
      }
      expect(topicCryptoRule.evaluate(bundle).value).toBe(expected)
    },
  )

  it('is not evaluable and false when the followee sample is one short of the minimum', () => {
    const result = topicCryptoRule.evaluate({
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_crypto: {
          followeeLabeledCount: 14,
          followeeTotalCount: 14,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    })
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
  })

  it('is evaluable at exactly the minimum followee sample', () => {
    const result = topicCryptoRule.evaluate({
      ...makeBundle({}),
      followGraphLabelSignals: {
        topic_crypto: {
          followeeLabeledCount: 0,
          followeeTotalCount: 15,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    })
    expect(result.evaluable).toBe(true)
  })

  it('直近投稿の取得に失敗している場合、フォローグラフ一致だけの false は判定不能になる', () => {
    const bundle = {
      ...makeBundle({ recentTweetsFetchStatus: 'failed' }),
      followGraphLabelSignals: {
        topic_crypto: {
          followeeLabeledCount: 50,
          followeeTotalCount: 100,
          followerLabeledCount: 0,
          followerTotalCount: 0,
        },
      },
    }
    const result = topicCryptoRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
  })
})
