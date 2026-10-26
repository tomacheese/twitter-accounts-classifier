// 境界は空白限定ではなく「文字・数字・アンダースコアに隣接していないこと」で表現している。
// 「#PR」は直前の文章や句読点に隣接して書かれたり、
// JS の `\s` にマッチしないゼロ幅スペース (U+200B) の後に置かれたりすることが多く、
// 空白必須の境界では正規の開示表記を見逃すため。
// 左側の境界は `.../page#PR` のような URL フラグメントを除外し、
// 右側の境界は `#PRIDE2026` のような無関係な長いハッシュタグを除外する。
const PR_HASHTAG_PATTERN = /(?<![\p{L}\p{N}_])#PR(?![\p{L}\p{N}_])/iu

// 角括弧・丸括弧による開示表記は日本語 Twitter における慣習的な書き方であり、
// ASCII 表記の `(PR)` は英語で「public relations」や「pull request」を指す用法と衝突するため、
// 日本語テキストを伴うツイートに限って両方の表記を信頼する。
const PR_BRACKET_PATTERN = /[【（([]\s*PR\s*[】）)\]]/iu
const JAPANESE_TEXT_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u

/**
 * 本文が日本語の広告開示マーカーを含むかどうかを判定する。
 * @param fullText - 判定対象のツイート本文
 * @returns 「#PR」ハッシュタグまたは括弧付き「PR」開示表記が含まれる場合は true
 */
function hasPrDisclosureMarker(fullText: string): boolean {
  if (PR_HASHTAG_PATTERN.test(fullText)) return true
  return PR_BRACKET_PATTERN.test(fullText) && JAPANESE_TEXT_PATTERN.test(fullText)
}

// 懸賞・キャンペーンへの応募ツイートは、主催者側の企画ハッシュタグと共に「#PR」風のハッシュタグを含むことがあるが、
// それは他者の懸賞への応募であって自身のスポンサー開示ではないため、開示とみなさない。
// 「キャンペーン」等の語だけで判定すると、商品提供を受けたレビュー投稿の企画名にも同じ語が現れて誤って除外されるため、
// 投稿者自身が応募者側であることを示す一人称的な行動 (応募した・当選しますように等) に限定する。
const CAMPAIGN_ENTRY_PATTERN =
  /(応募し(まし|て)た|当た(りますように|りました)|抽選で.{0,10}(当たり|当選))/u

// 懸賞の応募引用ツイートに付く「#PR」は、主催者が応募条件として義務づけたタグであり自身の広告開示ではない。
// 一人称の応募表現を書かない短い引用ツイートも多いため、本文の長さと応募語の有無で判定する。
// 引用でない投稿や、本文が長い投稿は商品紹介の可能性が高く、除外しない。
const SHORT_QUOTE_MAX_BODY_LENGTH = 40
const SWEEPSTAKES_ENTRY_WORD_PATTERN =
  /応募|参加|エントリー|懸賞|プレゼント|キャンペーン|企画|RT|リポスト/iu

function isShortSweepstakesQuote(fullText: string): boolean {
  const body = fullText
    .replaceAll(/https?:\/\/\S+/gu, '')
    .replaceAll(/[#＃@＠]\S+/gu, '')
    .trim()
  return body.length <= SHORT_QUOTE_MAX_BODY_LENGTH && SWEEPSTAKES_ENTRY_WORD_PATTERN.test(fullText)
}

/**
 * 本文が自身のスポンサー開示として信頼できる PR マーカーを含むかどうかを判定する。
 * 懸賞・キャンペーンへの応募を示す一人称的な表現を伴う場合や、
 * 懸賞応募の短い引用ツイートである場合は、他者の企画への応募であって自身の開示ではないため false にする。
 * @param fullText - 判定対象のツイート本文
 * @param options - `isQuote` は引用ツイートであること
 * @returns PR 開示として信頼できる場合は true
 */
export function hasPrDisclosure(fullText: string, options: { isQuote?: boolean } = {}): boolean {
  if (!hasPrDisclosureMarker(fullText)) return false
  if (CAMPAIGN_ENTRY_PATTERN.test(fullText)) return false
  return !(options.isQuote === true && isShortSweepstakesQuote(fullText))
}
