import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 「保守」「リベラル」のような曖昧なイデオロギー用語は、
// 保守がエンジニア系 bio では「メンテナンス」の意味で使われたり、
// リベラルが政治と無関係な文脈でも使われたりするため、
// 誤検知を避けて具体的な政党名や公職名のみに限定している。
// 英単語は無関係な語の内部に一致しないよう単語境界で判定している。
const PARTY_AFFILIATION_PATTERN =
  /(?:自民党|立憲民主党|公明党|共産党|日本維新の会|国民民主党|れいわ新選組|参政党)(?:\s*(?:所属|党員|公認|支部長))/i
// 修飾語を伴わない裸の公職名も、congressman/senator/politician と同様に
// 自己申告以外の文脈 (願望・他者評など) で文末に現れうるため、無条件の文末一致 ($) は対象としない。
// 具体的な議席名 (市議会議員など) は、
// "｜"/"∣" によるタグ区切り形式の bio でも自己申告として現れる。
// "/" は「A議員/B議員の会合」のように他者の列挙にも使われるため対象から除く。
// 「政治家」は自称としての具体性が低く、タグ区切りの対象にもしない。
const JAPANESE_SPECIFIC_OFFICE_TITLE_PATTERN =
  /(?:衆議院議員|参議院議員|県議会議員|市議会議員|国会議員)(?:を)?(?:しています|です|として活動|として働いています|[、,｜∣])/i
const JAPANESE_GENERIC_POLITICIAN_PATTERN =
  /政治家(?:を)?(?:しています|です|として活動|として働いています|[、,])/i
// 修飾語を伴わない裸の "congressman"/"senator"/"politician" は自嘲や他者評など
// 自己申告以外の文脈でも現れるため、地域を示す state 接頭辞か for/of/district を伴う場合のみ対象とする。
const ENGLISH_OFFICE_SELF_IDENTIFICATION_PATTERN =
  /\bstate\s+(?:congressman|senator|politician)\b|\b(?:congressman|senator|politician)\s+(?:for|of|district)\b/i

// 「元衆議院議員」「Former state senator」のように「元/former」を伴う bio は、
// 現職ではなく過去の在職を述べているだけで、
// 「非自民党党員」のように「非」を伴う bio は、
// 所属の否定を述べているだけで、
// いずれも description が要求する「現に公職者・党員である」ことの自己申告にはならない。
// 一致箇所の直前だけを見れば足りるため、window は短くしている。
const NEGATION_PREFIX_WINDOW_LENGTH = 10
const NEGATION_PREFIX_PATTERN = /元\s*$|非\s*$|\bformer\s*$/i

function isNegatedOfficeMention(bio: string, matchIndex: number): boolean {
  const beforeMatch = bio.slice(Math.max(0, matchIndex - NEGATION_PREFIX_WINDOW_LENGTH), matchIndex)
  return NEGATION_PREFIX_PATTERN.test(beforeMatch)
}

function matchesCurrentOffice(bio: string, pattern: RegExp): boolean {
  const match = pattern.exec(bio)
  return match !== null && !isNegatedOfficeMention(bio, match.index)
}

export const topicPoliticsRule: LabelRule = {
  key: 'topic_politics',
  description: 'プロフィールで政党への所属や選挙で選ばれた公職者であることを示している',
  // 政治的意見に関わる機微カテゴリであり、
  // フォローグラフからの推測だけで確定させることは避け、自己申告の bio のみを根拠とする。
  version: '1.4.1',
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch =
      bio !== null &&
      (matchesCurrentOffice(bio, PARTY_AFFILIATION_PATTERN) ||
        matchesCurrentOffice(bio, JAPANESE_SPECIFIC_OFFICE_TITLE_PATTERN) ||
        matchesCurrentOffice(bio, JAPANESE_GENERIC_POLITICIAN_PATTERN) ||
        matchesCurrentOffice(bio, ENGLISH_OFFICE_SELF_IDENTIFICATION_PATTERN))
    return {
      value: keywordMatch,
      confidence: toConfidence(keywordMatch, keywordMatch ? 0.8 : 0),
      reason: `bio politics-keyword match=${keywordMatch}`,
    }
  },
}
