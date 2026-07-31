// Shared by reply-flooding.ts (one account flooding a single target with paraphrased
// replies) and reply-hijack-index.ts (many accounts each replying once to one target with
// paraphrased text): both measure paraphrase-level textual similarity, differing only in
// the axis they group by.
const URL_PATTERN = /https?:\/\/\S+/g
const MENTION_PATTERN = /@\w+/g
const WHITESPACE_PATTERN = /\s+/g

/**
 * Normalizes text for pairwise similarity comparison: strips URLs and @mentions (which
 * differ between otherwise-identical paraphrases), collapses whitespace, and lowercases.
 * @param text - the raw tweet text
 * @returns the normalized text
 */
export function normalizeForSimilarity(text: string): string {
  return text
    .replaceAll(URL_PATTERN, '')
    .replaceAll(MENTION_PATTERN, '')
    .replaceAll(WHITESPACE_PATTERN, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Builds the set of character bigrams (2-character substrings) in `text`.
 *
 * Character bigrams rather than word tokens: Japanese text has no whitespace between
 * words, so a word-boundary tokenizer would treat most Japanese replies as a single token
 * and never detect their overlap.
 * @param text - already-normalized text
 * @returns the set of bigrams; a single-character string yields a one-element set
 */
export function bigramSet(text: string): Set<string> {
  const bigrams = new Set<string>()
  if (text.length < 2) {
    if (text.length === 1) bigrams.add(text)
    return bigrams
  }
  for (let i = 0; i < text.length - 1; i++) bigrams.add(text.slice(i, i + 2))
  return bigrams
}

/**
 * Computes the Jaccard similarity (intersection over union) between two bigram sets.
 * @param a - first bigram set
 * @param b - second bigram set
 * @returns a value in `[0, 1]`, or 0 if either set is empty
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const bigram of a) {
    if (b.has(bigram)) intersection++
  }
  return intersection / (a.size + b.size - intersection)
}

/**
 * Computes the average Jaccard similarity across every distinct pair of texts, after
 * normalizing and bigram-tokenizing each.
 * @param texts - raw texts to compare pairwise
 * @returns the average pairwise similarity, or 0 if fewer than 2 texts are given
 */
export function averagePairwiseSimilarity(texts: string[]): number {
  const bigramSets = texts.map((text) => bigramSet(normalizeForSimilarity(text)))
  let total = 0
  let pairs = 0
  for (let i = 0; i < bigramSets.length; i++) {
    for (let j = i + 1; j < bigramSets.length; j++) {
      total += jaccardSimilarity(bigramSets[i], bigramSets[j])
      pairs++
    }
  }
  return pairs === 0 ? 0 : total / pairs
}
