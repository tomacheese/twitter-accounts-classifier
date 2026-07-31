import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated words
// (e.g. "NBA"/"MLB" as substrings). Japanese terms are left as substring matches since
// word boundaries don't apply the same way to Japanese script.
//
// スポーツ excludes a preceding "e" (half- or full-width, either case) so that eスポーツ
// ("esports") is not tagged as sports: esports is a gaming topic already covered by
// topic_gaming's own eスポーツ term, and esports players/venues were a recurring
// false-positive source here.
const SPORTS_PATTERN =
  /\b(baseball|soccer|basketball|NBA|MLB|NPB)\b|(?<![eEｅＥ])スポーツ|野球|サッカー|バスケ(ットボール)?|Jリーグ/i

export const topicSportsRule: LabelRule = {
  key: 'topic_sports',
  description: 'プロフィールでスポーツを中心的な関心事として挙げている',
  version: '1.1.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && SPORTS_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio sports-keyword match=${value}`,
    }
  },
}
