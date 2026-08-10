import type { LabelRule } from '../types'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'

// crypto は cryptography 等の無関係な語に含まれてしまうため単語境界で判定しつつ、
// cryptocurrency のような正当な語は除外しないよう否定先読みを用いている。
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
const CRYPTO_PATTERN =
  /\b(crypto(?!graph)|bitcoin|nft|web3|blockchain)|仮想通貨|ビットコイン|ブロックチェーン/i

// イラストレーターが自作の無断 NFT 化を拒否する目的で bio に NFT 等の語を書くことが多く、
// これを関心事の申告と誤認してしまう。禁止マーカーが用語の直後に来ることが多いため、
// 一致箇所の前後を確認する。
const REJECTION_WINDOW_LENGTH = 15
const REJECTION_PATTERN = /🚫|🈲|❌|禁止|お断り|お断わり|NG/i

function isRejectedMention(bio: string, match: RegExpExecArray): boolean {
  const beforeMatch = bio.slice(Math.max(0, match.index - REJECTION_WINDOW_LENGTH), match.index)
  const afterMatch = bio.slice(
    match.index + match[0].length,
    match.index + match[0].length + REJECTION_WINDOW_LENGTH,
  )
  return REJECTION_PATTERN.test(beforeMatch) || REJECTION_PATTERN.test(afterMatch)
}

export const topicCryptoRule: LabelRule = {
  key: 'topic_crypto',
  description: 'プロフィールで暗号資産/web3 を中心的な関心事として挙げている',
  version: '1.2.0',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const match = bio === null ? null : CRYPTO_PATTERN.exec(bio)
    const keywordMatch = match !== null && !isRejectedMention(bio ?? '', match)
    const followGraphMatch = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_crypto)
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio crypto-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
