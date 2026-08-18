import { combineAlternatives, toConfidence } from '../confidence'
import type { LabelRule } from '../types'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'

// crypto は cryptography 等の無関係な語に含まれてしまうため単語境界で判定しつつ、
// cryptocurrency のような正当な語は除外しないよう否定先読みを用いている。
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
const CRYPTO_PATTERN =
  /\b(crypto(?!graph)|bitcoin|nft|web3|blockchain)|仮想通貨|ビットコイン|ブロックチェーン/gi

// イラストレーターが自作の無断 NFT 化を拒否する目的で bio に NFT 等の語を書くことが多く、
// これを関心事の申告と誤認してしまう。禁止マーカーが用語の直後に来ることが多いため、
// 一致箇所の前後を確認する。
// 絵文字・「禁止」「お断り」は用語と無関係な文脈に現れることが稀なため広い window で確認する一方、
// 「NG」「no」「not」は単語境界を付けても、
// 「NFTs are not going anywhere」のように無関係な地の文と偶然近接しうるため、
// 用語に直接隣接する場合のみ拒否とみなす狭い window にしている。
const REJECTION_WINDOW_LENGTH = 15
const STRONG_REJECTION_PATTERN = /🚫|🈲|❌|禁止|お断り|お断わり/
const WEAK_REJECTION_WINDOW_LENGTH = 4
const WEAK_REJECTION_PATTERN = /\bNG\b|\bno\b|\bnot\b/i

function isRejectedMention(bio: string, match: RegExpMatchArray): boolean {
  const index = match.index ?? 0
  const strongBeforeMatch = bio.slice(Math.max(0, index - REJECTION_WINDOW_LENGTH), index)
  const strongAfterMatch = bio.slice(
    index + match[0].length,
    index + match[0].length + REJECTION_WINDOW_LENGTH,
  )
  if (
    STRONG_REJECTION_PATTERN.test(strongBeforeMatch) ||
    STRONG_REJECTION_PATTERN.test(strongAfterMatch)
  ) {
    return true
  }
  const weakBeforeMatch = bio.slice(Math.max(0, index - WEAK_REJECTION_WINDOW_LENGTH), index)
  const weakAfterMatch = bio.slice(
    index + match[0].length,
    index + match[0].length + WEAK_REJECTION_WINDOW_LENGTH,
  )
  return WEAK_REJECTION_PATTERN.test(weakBeforeMatch) || WEAK_REJECTION_PATTERN.test(weakAfterMatch)
}

// 最初の一致だけを見ると、先に来た拒否表現につられて後方の正当な申告を見逃す。
// そのため全ての一致箇所を判定し、いずれかが拒否文脈でなければ申告とみなす。
function hasGenuineCryptoMention(bio: string): boolean {
  const matches = [...bio.matchAll(CRYPTO_PATTERN)]
  return matches.some((match) => !isRejectedMention(bio, match))
}

const KEYWORD_SCORE = 0.8

export const topicCryptoRule: LabelRule = {
  key: 'topic_crypto',
  description: 'プロフィールの直接証拠、またはフォロー関係から暗号資産/web3 との強い関連が示される',
  version: '1.3.3',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && hasGenuineCryptoMention(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_crypto)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio crypto-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
