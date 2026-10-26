// 懸賞・キャンペーンへの定型的な応募返信は、勧誘や使い回しではなく応募の意思表示であるため根拠にしない。
// ただしプロフィールへの誘導を併記する返信は、応募の言及を混ぜた勧誘でありうるため除外しない。
const CAMPAIGN_ENTRY_PATTERN =
  /(?:応募(?:し(?:まし)?た|します|いたします|させていただきます)|当(?:た|選)りますように|当選しますように|当選しました|当たりました|当(?:た|選)ったら|参加(?:します|いたします|させていただきます))/u
const PROFILE_GUIDANCE_PATTERN = /プロフ(?:ィール)?(?:から|を|欄|へ|に|は)/u

/**
 * 応募の意思表示だけで勧誘を含まない返信かどうかを返す。
 * @param text - 判定対象の本文
 * @returns キャンペーン応募の定型返信なら true
 */
export function isCampaignEntryText(text: string): boolean {
  return CAMPAIGN_ENTRY_PATTERN.test(text) && !PROFILE_GUIDANCE_PATTERN.test(text)
}
