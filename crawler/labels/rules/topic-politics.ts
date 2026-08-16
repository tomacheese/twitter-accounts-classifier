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
// 修飾語を伴わない裸の "politician" は自嘲や他者評など自己申告以外の文脈でも現れるため、
// congressman・senator とは異なり、地域を示す state 接頭辞か for/of/district を伴う場合のみ対象とする。
const ENGLISH_OFFICE_SELF_IDENTIFICATION_PATTERN =
  /\b(?:state\s+)?(?:congressman|senator)\b(?:\s*,|\s+(?:for|of|district)\b|$)|\b(?:state\s+politician\b|politician\s+(?:for|of|district)\b)/i

// 「元衆議院議員」「Former state senator」のように「元/former」を伴う bio は、
// 現職ではなく過去の在職を述べているだけで、
// description が要求する「現に公職者である」ことの自己申告にはならない。
// 一致箇所の直前だけを見れば足りるため、window は短くしている。
const FORMER_PREFIX_WINDOW_LENGTH = 10
const FORMER_PREFIX_PATTERN = /元\s*$|\bformer\s*$/i

function isFormerOfficeMention(bio: string, matchIndex: number): boolean {
  const beforeMatch = bio.slice(Math.max(0, matchIndex - FORMER_PREFIX_WINDOW_LENGTH), matchIndex)
  return FORMER_PREFIX_PATTERN.test(beforeMatch)
}

function matchesCurrentOffice(bio: string, pattern: RegExp): boolean {
  const match = pattern.exec(bio)
  return match !== null && !isFormerOfficeMention(bio, match.index)
}

export const topicPoliticsRule: LabelRule = {
  key: 'topic_politics',
  description: 'プロフィールで政党への所属や選挙で選ばれた公職者であることを示している',
  // 政治的意見に関わる機微カテゴリであり、
  // フォローグラフからの推測だけで確定させることは避け、自己申告の bio のみを根拠とする。
  version: '1.3.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch =
      bio !== null &&
      (matchesCurrentOffice(bio, PARTY_AFFILIATION_PATTERN) ||
        matchesCurrentOffice(bio, JAPANESE_OFFICE_SELF_IDENTIFICATION_PATTERN) ||
        matchesCurrentOffice(bio, ENGLISH_OFFICE_SELF_IDENTIFICATION_PATTERN))
    return {
      value: keywordMatch,
      confidence: toConfidence(keywordMatch, keywordMatch ? 0.8 : 0),
      reason: `bio politics-keyword match=${keywordMatch}`,
    }
  },
}
