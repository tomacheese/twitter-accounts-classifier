import type { LabelRule } from '../types'

// 境界は空白限定ではなく「文字・数字・アンダースコアに隣接していないこと」で表現している。
// 「#PR」は直前の文章や句読点に隣接して書かれたり、JS の `\s` にマッチしないゼロ幅スペース
// (U+200B) の後に置かれたりすることが多く、空白必須の境界では正規の開示表記を見逃すため。
// 左側の境界は `.../page#PR` のような URL フラグメントを除外し、右側の境界は
// `#PRIDE2026` のような無関係な長いハッシュタグを除外する。
const PR_HASHTAG_PATTERN = /(?<![\p{L}\p{N}_])#PR(?![\p{L}\p{N}_])/iu

// 角括弧・丸括弧による開示表記は日本語 Twitter における慣習的な書き方であり、
// ASCII 表記の `(PR)` は英語で「public relations」や「pull request」を指す用法と衝突するため、
// 日本語テキストを伴うツイートに限って両方の表記を信頼する。
const PR_BRACKET_PATTERN = /[【（([]\s*PR\s*[】）)\]]/iu
const JAPANESE_TEXT_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u

/**
 * ツイート本文が日本語の広告開示マーカーを含むかどうかを判定する。
 * @param fullText - ツイート本文
 * @returns 「#PR」ハッシュタグまたは括弧付き「PR」開示表記が含まれる場合は true
 */
function hasPrDisclosureMarker(fullText: string): boolean {
  if (PR_HASHTAG_PATTERN.test(fullText)) return true
  return PR_BRACKET_PATTERN.test(fullText) && JAPANESE_TEXT_PATTERN.test(fullText)
}

// 懸賞・キャンペーンの応募ツイートは、主催者側のキャンペーンハッシュタグと共に
// 「#PR」風のハッシュタグを含むことがあるが、それは他者の懸賞への応募であって
// 自身のスポンサー開示ではないため、このラベルの対象から除外する。
const CAMPAIGN_ENTRY_PATTERN = /キャンペーン|懸賞|当選|抽選|応募|当たりますように|プレゼント企画/i

// サンプル数が極端に少ない状態で `isPaidPromotion` フラグ単体を信頼すると、
// 1件の誤判定・不明瞭な判定がアカウント全体の判定を左右してしまうため、
// 最低限のサンプル数を要求する。
const MIN_SAMPLE_FOR_PAID_PROMOTION_FLAG = 3

export const adPrHashtagRule: LabelRule = {
  key: 'ad_pr_hashtag',
  description:
    '日本の Twitter で慣習的に使われる「#PR」ハッシュタグ、または X 公式の有償パートナーシップ開示機能のいずれかで、広告ツイートであることを適切に開示している',
  version: '1.2.0',
  evaluate(bundle) {
    // このラベルはアカウント自身の投稿における開示を主張するものであるため、
    // リツイート(他者が書いた本文に `RT @...` を付与したもの)は対象から除外する。
    // 除外しない場合、他者の「#PR」付き投稿をリツイートしただけで、
    // リツイートしたアカウント自身が開示していると誤判定されてしまう。
    const sampled = bundle.recentTweets.filter((t) => !t.isRetweet)
    const hasPrHashtag = sampled.some(
      (t) => hasPrDisclosureMarker(t.fullText) && !CAMPAIGN_ENTRY_PATTERN.test(t.fullText),
    )
    const hasPaidPromotionDisclosure =
      sampled.length >= MIN_SAMPLE_FOR_PAID_PROMOTION_FLAG && sampled.some((t) => t.isPaidPromotion)

    const value = hasPrHashtag || hasPaidPromotionDisclosure
    const confidence = (hasPrHashtag ? 0.6 : 0) + (hasPaidPromotionDisclosure ? 0.6 : 0)

    return {
      value,
      confidence: Math.min(confidence, 1),
      reason: `prHashtag=${hasPrHashtag}, paidPromotionDisclosure=${hasPaidPromotionDisclosure} (n=${sampled.length})`,
    }
  },
}
