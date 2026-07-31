import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated words
// (e.g. "crypto" inside "cryptography"/"cryptographic"); "crypto" additionally excludes
// the "-graph-" continuation via negative lookahead so it still matches legitimate
// substrings like "cryptocurrency". Japanese terms are left as substring matches since
// word boundaries don't apply the same way to Japanese script.
const CRYPTO_PATTERN = /\b(crypto(?!graph)|bitcoin|nft|web3|blockchain)|仮想通貨|ビットコイン|ブロックチェーン/i

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
