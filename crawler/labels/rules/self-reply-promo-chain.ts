import { rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 1 回だけの self-promo を positive にしないための下限。
const MIN_ROOTS_FOR_POSITIVE = 3
// この件数以上で confidence が 1.0 に達するようにする。
const STRONG_ROOTS = 5

/**
 * chain の深さ自体は誘導手口の巧妙さを示すだけで反復性の証拠にはならないため、
 * confidence の算出には使わず reason 文字列にのみ含める。
 */
export const selfReplyPromoChainRule: LabelRule = {
  key: 'self_reply_promo_chain',
  description:
    '独立した自分の投稿への self-reply で第三者の X 投稿へ誘導する動きが、' +
    '同一誘導先への反復か、誘導 self-reply からさらに誘導 self-reply へ連結する多段チェーンか、' +
    'いずれかの形で複数系統観測される',
  version: '1.0.0',
  evaluate(bundle) {
    const evidence = bundle.selfReplyPromoEvidence
    const promoRoots = evidence?.promoRoots ?? 0
    const exactDestinationRoots = evidence?.exactDestinationRoots ?? 0
    const multiHopRoots = evidence?.multiHopRoots ?? 0
    const maxChainDepth = evidence?.maxChainDepth ?? 0
    const reason = `promoRoots=${promoRoots}, exactDestinationRoots=${exactDestinationRoots}, multiHopRoots=${multiHopRoots}, maxDepth=${maxChainDepth}`

    const value =
      exactDestinationRoots >= MIN_ROOTS_FOR_POSITIVE || multiHopRoots >= MIN_ROOTS_FOR_POSITIVE
    if (!value) {
      // TweetDetail で self-reply chain を観測できなかったことを「存在しない」と断定しないため、
      // 陰性側は evaluable=false・confidence=0.5 (中立値) として扱う。
      return { value: false, confidence: 0.5, reason, evaluable: false }
    }

    const evidenceScore = rampScore(
      promoRoots,
      MIN_ROOTS_FOR_POSITIVE,
      STRONG_ROOTS - MIN_ROOTS_FOR_POSITIVE,
      'higher-is-positive',
    )
    return { value: true, confidence: toConfidence(true, evidenceScore), reason, evaluable: true }
  },
}
