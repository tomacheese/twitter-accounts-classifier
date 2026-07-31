import type { LabelRule } from '../types'

// Restricted to concrete party names and specific political-office titles rather than
// vague ideological terms (e.g. "保守"/"conservative" also commonly means "maintenance" in
// unrelated engineering bios, and "リベラル"/"liberal" is used non-politically too) to keep
// false-positive risk low. English terms are word-boundary-matched to avoid matching
// inside unrelated words.
const POLITICS_PATTERN =
  /自民党|立憲民主党|公明党|共産党|日本維新の会|国民民主党|れいわ新選組|参政党|衆議院議員|参議院議員|県議会議員|市議会議員|国会議員|政治家|\bpolitician\b|\bcongressman\b|\bsenator\b/i

export const topicPoliticsRule: LabelRule = {
  key: 'topic_politics',
  description: 'プロフィールで政党への所属や選挙で選ばれた公職者であることを示している',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && POLITICS_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio politics-keyword match=${value}`,
    }
  },
}
