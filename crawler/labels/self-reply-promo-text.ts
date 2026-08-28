const URL_PATTERN = /https?:\/\/\S+/g
const MENTION_PATTERN = /@\w+/g
const WHITESPACE_PATTERN = /\s+/g
// 誘導文で頻出する強調表現は繰り返し回数だけが異なることが多く、
// 回数の違いを別文言として扱うと明らかな同一文言の一致を取りこぼすため、1文字に畳む。
// 全角・半角の表記ゆれも同一文言として扱うため、畳む前に半角へ揃える。
const FULLWIDTH_EXCLAMATION_PATTERN = /！/g
const REPEATED_ARROW_PATTERN = /[↓↘⇓]{2,}/g
const REPEATED_EXCLAMATION_PATTERN = /!{2,}/g

/**
 * self-reply promo chain 検出用にリプライ本文を正規化する。
 * duplicate-reply-index.ts の normalizeReplyText と異なり、
 * 短い誘導文を検出対象から漏らさないよう文字数による足切りをしない。
 * @param text - ツイートの生本文
 * @returns 正規化後のテキスト。URL のみのリプライは空文字列になる
 */
export function normalizeSelfReplyPromoText(text: string): string {
  return text
    .replaceAll(URL_PATTERN, '')
    .replaceAll(MENTION_PATTERN, '')
    .replaceAll(FULLWIDTH_EXCLAMATION_PATTERN, '!')
    .replaceAll(REPEATED_ARROW_PATTERN, '↓')
    .replaceAll(REPEATED_EXCLAMATION_PATTERN, '!')
    .replaceAll(WHITESPACE_PATTERN, ' ')
    .trim()
    .toLowerCase()
}
