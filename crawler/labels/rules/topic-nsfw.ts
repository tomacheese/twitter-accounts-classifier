import type { LabelRule } from '../types'

// Deliberately restricted to explicit adult-content markers (age-rating labels and direct
// self-identification terms) rather than broad innuendo, to keep false-positive risk low.
// English terms are word-boundary-matched to avoid matching inside unrelated words.
const NSFW_PATTERN = /\bNSFW\b|R-?18|18禁|成人向け|アダルト|無修正/i

// Bios that name an NSFW term only to declare they do NOT post or want it ("nsfw dni",
// "DNI: nsfw accounts", "I do not support: Nsfw", "R18の話題は✖") are a recurring
// false-positive source - often self-declared minors warning adult accounts away. Matching
// any of these suppresses the label.
//
// The "DNI" ("do not interact") forms are restricted to an NSFW term adjacent to DNI
// inside the same bio segment - no "|"/"｜" separator and no "@" in between - so that the
// opposite, genuinely-NSFW "🔞NSFW Artist | MINORS DNI" and "nsfw @alt_account | minors
// dni" phrasings, where DNI addresses minors rather than NSFW, keep matching.
const ANTI_NSFW_PATTERNS = [
  /(?:\bNSFW\b|\bR-?18\b)[^|｜@\n]{0,20}\bDNI\b/i,
  /\bDNI\b[^|｜@\n]{0,20}(?:\bNSFW\b|\bR-?18\b)/i,
  /\b(?:not|never)\b[^|｜\n]{0,20}\b(?:support|post|do|draw|share)\b[^|｜\n]{0,40}(?:\bNSFW\b|\bR-?18\b)/i,
  /(?:NSFW|R-?18|18禁|成人向け|アダルト)(?:の[^|｜\n]{0,6})?は[✖×✗❌]/i,
]

export const topicNsfwRule: LabelRule = {
  key: 'topic_nsfw',
  description: 'プロフィールでアダルト/NSFW コンテンツを投稿していることを自己申告している',
  version: '1.1.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value =
      bio !== null &&
      NSFW_PATTERN.test(bio) &&
      !ANTI_NSFW_PATTERNS.some((pattern) => pattern.test(bio))
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio nsfw-keyword match=${value}`,
    }
  },
}
