import type { LabelRule } from '../types'

// "推し" ("oshi") is deliberately absent: it is now generic Japanese internet slang for "my
// favorite [anything]" and is applied to anime/game characters, VTubers (covered by
// topic_vtuber), sports figures, actors, animals and even cities, so on its own it cannot
// distinguish idol fandom from any other kind of fandom. English terms are
// word-boundary-matched to avoid matching inside unrelated words.
const IDOL_PATTERN = /アイドル|\bidol\b|k-?pop|ジャニーズ|ハロプロ|坂道/i

export const topicIdolRule: LabelRule = {
  key: 'topic_idol',
  description: 'プロフィールでアイドル/推し活を中心的な関心事として挙げている',
  version: '1.1.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && IDOL_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio idol-keyword match=${value}`,
    }
  },
}
