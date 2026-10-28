// 懸賞・キャンペーンへの定型的な応募返信は、勧誘や使い回しではなく応募の意思表示であるため根拠にしない。
// ただしプロフィールへの誘導を併記する返信は、応募の言及を混ぜた勧誘でありうるため除外しない。
const CAMPAIGN_ENTRY_PATTERN =
  /(?:応募(?:し(?:まし)?た|します|いたします|させていただきます)|当(?:た|選)りますように|当選しますように|当選しました|当たりました|当(?:た|選)ったら|参加(?:します|いたします|させていただきます))/u
const PROFILE_GUIDANCE_PATTERN = /プロフ(?:ィール)?(?:から|を|欄|へ|に|は)/u
// ハッシュタグだけの返信は、懸賞応募やファン企画への参加表明と勧誘文を区別できない。
// 勧誘文は文言を伴うため、文言のないハッシュタグ列は応募・企画への参加として扱う。
// タグ本文に # を含めないのは、# の連続で分割の仕方が複数でき、不一致時に指数的に遅くなるため。
const HASHTAG_ONLY_PATTERN = /^(?:[#＃][^\s#＃]+\s*)+$/u

/**
 * 本文がハッシュタグだけで構成されているかを返す。
 * @param text - 判定対象の本文。URL やメンションは除去済みであること
 * @returns ハッシュタグのみなら true
 */
export function isHashtagOnlyText(text: string): boolean {
  return HASHTAG_ONLY_PATTERN.test(text.trim())
}

/**
 * 応募の意思表示だけで勧誘を含まない返信かどうかを返す。
 * @param text - 判定対象の本文
 * @returns キャンペーン応募の定型返信なら true
 */
export function isCampaignEntryText(text: string): boolean {
  return (
    isHashtagOnlyText(text) ||
    (CAMPAIGN_ENTRY_PATTERN.test(text) && !PROFILE_GUIDANCE_PATTERN.test(text))
  )
}
