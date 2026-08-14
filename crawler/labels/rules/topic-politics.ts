import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 「保守」「リベラル」のような曖昧なイデオロギー用語は、
// 保守がエンジニア系 bio では「メンテナンス」の意味で使われたり、
// リベラルが政治と無関係な文脈でも使われたりするため、
// 誤検知を避けて具体的な政党名や公職名のみに限定している。
// 英単語は無関係な語の内部に一致しないよう単語境界で判定している。
const PARTY_AFFILIATION_PATTERN =
  /(?:自民党|立憲民主党|公明党|共産党|日本維新の会|国民民主党|れいわ新選組|参政党)(?:\s*(?:所属|党員|公認|支部長))/i
const JAPANESE_OFFICE_SELF_IDENTIFICATION_PATTERN =
  /(?:衆議院議員|参議院議員|県議会議員|市議会議員|国会議員|政治家)(?:を)?(?:しています|です|として活動|として働いています|[、,]|$)/i
const ENGLISH_OFFICE_SELF_IDENTIFICATION_PATTERN =
  /\b(?:state\s+)?(?:politician|congressman|senator)\b(?:\s*,|\s+(?:for|of|district)\b|$)/i

export const topicPoliticsRule: LabelRule = {
  key: 'topic_politics',
  description: 'プロフィールで政党への所属や選挙で選ばれた公職者であることを示している',
  // 政治的意見に関わる機微カテゴリであり、
  // フォローグラフからの推測だけで確定させることは避け、自己申告の bio のみを根拠とする。
  version: '1.1.2',
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch =
      bio !== null &&
      (PARTY_AFFILIATION_PATTERN.test(bio) ||
        JAPANESE_OFFICE_SELF_IDENTIFICATION_PATTERN.test(bio) ||
        ENGLISH_OFFICE_SELF_IDENTIFICATION_PATTERN.test(bio))
    return {
      value: keywordMatch,
      confidence: toConfidence(keywordMatch, keywordMatch ? 0.8 : 0),
      reason: `bio politics-keyword match=${keywordMatch}`,
    }
  },
}
