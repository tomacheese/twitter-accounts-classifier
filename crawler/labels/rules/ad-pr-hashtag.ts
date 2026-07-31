import type { LabelRule } from '../types'

// Boundaries are expressed as "not adjacent to a letter/digit/underscore" rather than as
// literal whitespace: requiring whitespace on both sides missed roughly as many genuine
// disclosures as it caught, because `#PR` is routinely written flush against the preceding
// text or punctuation, or after a zero-width space (U+200B, which JS `\s` does not match).
// The left-hand boundary also keeps URL fragments such as `.../page#PR` out, and the
// right-hand one keeps longer, unrelated hashtags (`#PRIDE2026`) from matching.
const PR_HASHTAG_PATTERN = /(?<![\p{L}\p{N}_])#PR(?![\p{L}\p{N}_])/iu

// The bracketed/parenthesised disclosure forms are a Japanese typographic convention (this
// rule's own description scopes it to 「日本の Twitter で慣習的に使われる」 disclosure), and the
// ASCII form `(PR)` collides with English usage meaning "public relations" or "pull request".
// Both forms are therefore only trusted on tweets that actually contain Japanese text; the
// full-width 【】/（） brackets could stand alone, but gating both keeps one rule to reason about.
const PR_BRACKET_PATTERN = /[【（([]\s*PR\s*[】）)\]]/iu
const JAPANESE_TEXT_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u

/**
 * Reports whether one tweet's text carries a Japanese sponsorship-disclosure marker.
 * @param fullText - the tweet's text
 * @returns true when a `#PR` hashtag or a bracketed `PR` disclosure is present
 */
function hasPrDisclosureMarker(fullText: string): boolean {
  if (PR_HASHTAG_PATTERN.test(fullText)) return true
  return PR_BRACKET_PATTERN.test(fullText) && JAPANESE_TEXT_PATTERN.test(fullText)
}

// Giveaway/campaign-entry tweets routinely bundle a `#PR`-shaped hashtag alongside the
// sponsor's own campaign hashtags. Those are entries into someone else's giveaway, not the
// account's own sponsorship disclosure, so they must not carry this label.
const CAMPAIGN_ENTRY_PATTERN = /キャンペーン|懸賞|当選|抽選|応募|当たりますように|プレゼント企画/i

// A lone `isPaidPromotion` flag on a tiny sample is too weak to label a whole account: one
// stray or unclear flag would otherwise decide it. The same minimum-evidence pattern is used
// elsewhere in this codebase (see `ad-reply-hijack.ts`'s `MIN_REPLY_SAMPLE`).
const MIN_SAMPLE_FOR_PAID_PROMOTION_FLAG = 3

export const adPrHashtagRule: LabelRule = {
  key: 'ad_pr_hashtag',
  description:
    '日本の Twitter で慣習的に使われる「#PR」ハッシュタグ、または X 公式の有償パートナーシップ開示機能のいずれかで、広告ツイートであることを適切に開示している',
  version: '1.2.0',
  evaluate(bundle) {
    // This label claims the account's OWN content discloses sponsorship, so retweets
    // (which carry someone else's authored text, prefixed `RT @...`) must be excluded -
    // otherwise retweeting someone else's `#PR`-tagged post would falsely self-label the
    // retweeting account as a sponsorship discloser.
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
