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

/**
 * 本文が自身のスポンサー開示として信頼できる PR マーカーを含むかどうかを判定する。
 * 懸賞・キャンペーンへの応募を示す一人称的な表現を伴う場合は、
 * 他者の企画への応募であって自身の開示ではないため false にする。
 * @param fullText - 判定対象のツイート本文
 * @returns PR 開示として信頼できる場合は true
 */
export function hasPrDisclosure(fullText: string): boolean {
  return hasPrDisclosureMarker(fullText) && !CAMPAIGN_ENTRY_PATTERN.test(fullText)
}
