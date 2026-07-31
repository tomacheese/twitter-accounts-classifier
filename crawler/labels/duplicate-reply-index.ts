// URLs are stripped because t.co short links are unique per tweet even when the
// underlying long URL is identical across a bot network's posts, so keeping them would
// stop otherwise-identical template text from ever matching. @mentions are stripped for
// the same reason: every reply in a templated-reply network targets a different
// tweet/author, so the mention is precisely the part expected to differ between copies of
// one template.
const URL_PATTERN = /https?:\/\/\S+/g
const MENTION_PATTERN = /@\w+/g
const WHITESPACE_PATTERN = /\s+/g

// Below this length, normalized text is too generic ("ありがとうございます", "thanks!") to
// treat organic recurrence across accounts as a bot-network signal.
const MIN_NORMALIZED_LENGTH = 20

/**
 * Normalizes a reply's text for cross-account duplicate comparison.
 * @param text - the raw tweet text
 * @returns the normalized text, or an empty string if it is too short to be a meaningful
 *   duplicate-detection signal
 */
export function normalizeReplyText(text: string): string {
  const normalized = text
    .replaceAll(URL_PATTERN, '')
    .replaceAll(MENTION_PATTERN, '')
    .replaceAll(WHITESPACE_PATTERN, ' ')
    .trim()
    .toLowerCase()
  return normalized.length >= MIN_NORMALIZED_LENGTH ? normalized : ''
}

export interface ReplyCorpusEntry {
  accountId: string
  fullText: string
}

export interface DuplicateReplyIndex {
  /**
   * @param text - a reply's raw text to look up
   * @param excludeAccountId - the account whose own reply this is, excluded from the count
   * @returns the number of distinct accounts other than `excludeAccountId` that posted a
   *   reply whose normalized text matches `text`'s normalized form
   */
  countOtherAccounts(text: string, excludeAccountId: string): number
}

/**
 * Builds a cross-account duplicate-reply lookup from a corpus of reply tweets. A single
 * `LabelRule` only ever sees one account's own bundle, so this index is built once per
 * crawl/relabel run from a shared corpus and attached to each account's bundle as
 * `templatedReplyNetworkSize` before rules are evaluated - see `AccountFeatureBundle`.
 * @param corpus - reply tweets gathered from across the crawl/relabel run
 * @returns an index queryable per-account at bundle-build time
 */
export function buildDuplicateReplyIndex(corpus: ReplyCorpusEntry[]): DuplicateReplyIndex {
  const accountsByNormalizedText = new Map<string, Set<string>>()
  for (const entry of corpus) {
    const normalized = normalizeReplyText(entry.fullText)
    if (normalized === '') continue
    const accounts = accountsByNormalizedText.get(normalized) ?? new Set<string>()
    accounts.add(entry.accountId)
    accountsByNormalizedText.set(normalized, accounts)
  }

  return {
    countOtherAccounts(text, excludeAccountId) {
      const normalized = normalizeReplyText(text)
      if (normalized === '') return 0
      const accounts = accountsByNormalizedText.get(normalized)
      if (!accounts) return 0
      return accounts.has(excludeAccountId) ? accounts.size - 1 : accounts.size
    },
  }
}
