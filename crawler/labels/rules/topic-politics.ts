import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 「保守」「リベラル」のような曖昧なイデオロギー用語は、
// 保守がエンジニア系 bio では「メンテナンス」の意味で使われたり、
// リベラルが政治と無関係な文脈でも使われたりするため、
// 誤検知を避けて具体的な政党名や公職名のみに限定している。
// 英単語は無関係な語の内部に一致しないよう単語境界で判定している。
const PARTY_AFFILIATION_PATTERN =
  /(?:自民党|立憲民主党|公明党|共産党|日本維新の会|国民民主党|れいわ新選組|参政党)(?:\s*(?:所属|党員|公認|支部長))/gi
// 修飾語を伴わない裸の公職名も、congressman/senator/politician と同様に
// 自己申告以外の文脈 (願望・他者評など) で文末に現れうるため、無条件の文末一致 ($) は対象としない。
// 具体的な議席名 (市議会議員など) は、
// "｜"/"∣"/"／" によるタグ区切り形式の bio でも自己申告として現れる。
// 半角 "/" は「A議員/B議員の会合」のように他者の列挙にも使われるため対象から除く。
// 全角 "／" は他者列挙表記としては一般的でないため、区切り文字に含めても安全である。
// 「国会議員」「政治家」は両院の議席名ほど具体的でなく、
// 「国会議員、官庁、...向け」のような対象・宛先の列挙にも使われるため、
// タグ区切りだけでの一致対象からは外し、述語を伴う自己申告のみ対象とする。
const JAPANESE_SPECIFIC_OFFICE_TITLE_PATTERN =
  /(?:衆議院議員|参議院議員|県議会議員|市議会議員|国会議員)(?:を)?(?:しています|です|として活動|として働いています)|(?:衆議院議員|参議院議員|県議会議員|市議会議員)(?:を)?[、,｜∣／]/gi
// 修飾語を伴わない裸の "congressman"/"senator"/"politician" は自嘲や他者評など
// 自己申告以外の文脈でも現れるため、地域を示す state 接頭辞か for/of/district を伴う場合のみ対象とする。
const ENGLISH_OFFICE_SELF_IDENTIFICATION_PATTERN =
  /\bstate\s+(?:congressman|senator|politician)\b|\b(?:congressman|senator|politician)\s+(?:for|of|district)\b/gi

// 「元衆議院議員」「前○○市議会議員」「Former state senator」のように
// 「元/前/former」を伴う bio は現職ではなく過去の在職を述べているだけで、
// 「非自民党党員」のように「非」を伴う bio は所属の否定を述べているだけで、
// いずれも description が要求する「現に公職者・党員である」ことの自己申告にはならない。
// 「前」「元」は「前○○市議会議員」のように地名を挟んで職名に係ることが多いため、
// 直前の短い非ひらがな区間(地名相当)まで許容して判定する。
// ひらがなを挟む場合は「前から」のような無関係な文脈とみなし対象外にする。
const NEGATION_PREFIX_WINDOW_LENGTH = 10
const FORMER_OFFICE_HOLDER_PATTERN = /(?:元|前)[^\s、,。！?・\p{Script=Hiragana}]{0,6}$/u
const OTHER_NEGATION_PREFIX_PATTERN = /非\s*$|\bformer\s*$/i

function isNegatedOfficeMention(bio: string, matchIndex: number): boolean {
  const beforeMatch = bio.slice(Math.max(0, matchIndex - NEGATION_PREFIX_WINDOW_LENGTH), matchIndex)
  return (
    FORMER_OFFICE_HOLDER_PATTERN.test(beforeMatch) ||
    OTHER_NEGATION_PREFIX_PATTERN.test(beforeMatch)
  )
}

// 「将来なりたいのは市議会議員です」のような願望表現は、
// 自己申告の suffix (「です」「しています」等) を伴っていても
// 現に公職者・党員であることの自己申告にはならない。
// 願望の語と職名の間に「のは」のような助詞が挟まることがあるため、
// former-office-holder のチェックと異なり直前固定位置ではなく窓内の存在有無で判定する。
const ASPIRATION_WINDOW_LENGTH = 15
const ASPIRATION_CUE_PATTERN = /夢は|目指(?:し|す)|なりたい|志望/

function isAspirationMention(bio: string, matchIndex: number): boolean {
  const beforeMatch = bio.slice(Math.max(0, matchIndex - ASPIRATION_WINDOW_LENGTH), matchIndex)
  return ASPIRATION_CUE_PATTERN.test(beforeMatch)
}

// 「参議院議員、衆議院議員、○○大臣など歴任」のような列挙は、
// タグ区切りの現職自己申告と表記上区別できないが、文末の「歴任」が
// 列挙全体を過去の経歴一覧だと明示している。マーカーは列挙の末尾に来るため、
// 一致箇所より後ろの範囲を探索する。
const CAREER_HISTORY_MARKER = '歴任'
const CAREER_HISTORY_FORWARD_WINDOW_LENGTH = 80

function isPastCareerListingMention(bio: string, matchEndIndex: number): boolean {
  const forwardWindow = bio.slice(
    matchEndIndex,
    matchEndIndex + CAREER_HISTORY_FORWARD_WINDOW_LENGTH,
  )
  const sentenceEndIndex = forwardWindow.search(/[。\n]/)
  const scopedWindow =
    sentenceEndIndex === -1 ? forwardWindow : forwardWindow.slice(0, sentenceEndIndex)
  return scopedWindow.includes(CAREER_HISTORY_MARKER)
}

// 最初の一致だけで結論を出すと、「元衆議院議員です。現在は自民党所属、
// 参議院議員をしています」のように過去の在職に触れた直後に
// 独立した現職の自己申告が続く bio を誤って false にしてしまうため、
// 一致箇所をすべて走査していずれかが現職自己申告なら true とする。
function matchesCurrentOffice(bio: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(bio)) !== null) {
    if (
      !isNegatedOfficeMention(bio, match.index) &&
      !isAspirationMention(bio, match.index) &&
      !isPastCareerListingMention(bio, match.index + match[0].length)
    ) {
      return true
    }
    if (match[0].length === 0) pattern.lastIndex++
  }
  return false
}

export const topicPoliticsRule: LabelRule = {
  key: 'topic_politics',
  description: 'プロフィールで政党への所属や選挙で選ばれた公職者であることを示している',
  // 政治的意見に関わる機微カテゴリであり、
  // フォローグラフからの推測だけで確定させることは避け、自己申告の bio のみを根拠とする。
  version: '1.7.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch =
      bio !== null &&
      (matchesCurrentOffice(bio, PARTY_AFFILIATION_PATTERN) ||
        matchesCurrentOffice(bio, JAPANESE_SPECIFIC_OFFICE_TITLE_PATTERN) ||
        matchesCurrentOffice(bio, ENGLISH_OFFICE_SELF_IDENTIFICATION_PATTERN))
    return {
      value: keywordMatch,
      confidence: toConfidence(keywordMatch, keywordMatch ? 0.8 : 0),
      reason: `bio politics-keyword match=${keywordMatch}`,
    }
  },
}
