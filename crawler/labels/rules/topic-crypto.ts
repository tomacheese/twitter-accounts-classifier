import type { LabelRule } from '../types'

// crypto は cryptography 等の無関係な語に含まれてしまうため単語境界で判定しつつ、
// cryptocurrency のような正当な語は除外しないよう否定先読みを用いている。
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
const CRYPTO_PATTERN =
  /\b(crypto(?!graph)|bitcoin|nft|web3|blockchain)|仮想通貨|ビットコイン|ブロックチェーン/i

export const topicCryptoRule: LabelRule = {
  key: 'topic_crypto',
  description: 'プロフィールで暗号資産/web3 を中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && CRYPTO_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio crypto-keyword match=${value}`,
    }
  },
}
