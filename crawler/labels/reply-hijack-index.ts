import { averagePairwiseSimilarity, normalizeForSimilarity } from './text-similarity'

const MIN_DISTINCT_AUTHORS = 5
const WINDOW_HOURS = 24
// Tuned by simulating this index over a 20,000-reply production corpus. A threshold of
// 0.03 flagged 5.3% of the entire account database, sweeping in clearly organic mass
// reactions (condolence replies, congratulation pile-ons, hashtag campaigns). 0.1 still
// clears the spec's confirmed spam exemplar comfortably (it scores 0.234) while roughly
// halving textual noise (243 swarms/2,966 accounts -> 117 swarms/1,484 accounts). This
// threshold alone is not sufficient: see reply-hijack-swarm.ts's per-account low-effort
// guardrail, plus MIN_NORMALIZED_LENGTH below for the false positives no similarity
// threshold can separate.
const SIMILARITY_THRESHOLD = 0.1
// The dominant false positive for `reply_hijack_swarm` was not impression farming but
// community morning-greeting rituals - many real members each replying with a short
// greeting to the same person's daily morning tweet. Once @mentions are stripped such a
// greeting is only a handful of characters, so any two of them share nearly all their
// bigrams and score a Jaccard similarity near 1.0 - far above SIMILARITY_THRESHOLD -
// purely because there is almost no text to disagree about. Raising SIMILARITY_THRESHOLD
// cannot separate these, and reply-hijack-swarm.ts's low-effort guard cannot either, since
// greeting-culture accounts genuinely are reply-heavy.
//
// `duplicate-reply-index.ts` carries the same guard for the same reason; the value is
// deliberately kept identical.
//
// 20 came from re-simulating this index over a 115,243-reply corpus and sweeping the
// threshold against 20 hand-judged accounts: it leaves 3 of the 12 greeting accounts
// flagged (661 swarms/6,830 accounts -> 421/5,335), while 15 clears only 3 of them and 30
// clears all 12 at the cost of another 18% of overall coverage. Non-greeting accounts are
// essentially untouched (8 flagged -> 7).
//
// A second false-positive shape is deliberately NOT addressed here: genuine mass reactions
// where dozens of people each write a long, substantive reply under one announcement. By
// length and similarity alike those look identical to this rule's target pattern, and
// remain a known gap.
const MIN_NORMALIZED_LENGTH = 20

export interface ReplyHijackCorpusEntry {
  accountId: string
  fullText: string
  inReplyToTweetId: string | null
  createdAt: Date
}

export interface ReplyHijackIndex {
  /**
   * @param accountId - the account to look up
   * @param tweetId - the target tweet id this account replied to
   * @returns the size of the qualifying "reply-hijack swarm" this account/target pair
   *   belongs to (5+ distinct authors, each replying once, with similar paraphrased text,
   *   within a 24-hour window), or 0 if this pair is not part of one
   */
  swarmSizeFor(accountId: string, tweetId: string): number
}

/**
 * Builds a cross-account "reply-hijack swarm" lookup: discards replies whose text is too
 * short to carry a meaningful similarity signal, groups the rest by the target tweet they
 * reply to, keeps at most one reply per author per target (an author replying
 * more than once to the same target is `reply_flooding`'s pattern, not this one), and
 * flags groups of 5+ distinct authors whose replies fall within a 24-hour window and
 * whose text is similar (paraphrase-level, not necessarily verbatim) as a swarm. Built
 * once per crawl/relabel run from a shared corpus and attached to each account's bundle
 * as `replyHijackSwarmSize` before rules are evaluated - see `AccountFeatureBundle`.
 * `swarmSizeFor` reports raw structural swarm membership only; it is a necessary but not
 * sufficient signal for the `reply_hijack_swarm` rule, which additionally requires the
 * account's own profile to look low-effort.
 * @param corpus - reply tweets gathered from across the crawl/relabel run
 * @returns an index queryable per account/target pair at bundle-build time
 */
export function buildReplyHijackIndex(corpus: ReplyHijackCorpusEntry[]): ReplyHijackIndex {
  const firstReplyByAuthor = new Map<string, Map<string, ReplyHijackCorpusEntry>>()
  for (const entry of corpus) {
    if (entry.inReplyToTweetId === null) continue
    if (normalizeForSimilarity(entry.fullText).length < MIN_NORMALIZED_LENGTH) continue
    const byAuthor: Map<string, ReplyHijackCorpusEntry> =
      firstReplyByAuthor.get(entry.inReplyToTweetId) ?? new Map()
    const existing = byAuthor.get(entry.accountId)
    if (!existing) {
      byAuthor.set(entry.accountId, entry)
    } else if (entry.createdAt < existing.createdAt) {
      byAuthor.set(entry.accountId, entry)
    }
    firstReplyByAuthor.set(entry.inReplyToTweetId, byAuthor)
  }

  const swarmSizeByTarget = new Map<string, number>()
  const memberAccountsByTarget = new Map<string, Set<string>>()
  for (const [targetTweetId, byAuthor] of firstReplyByAuthor) {
    const replies = [...byAuthor.values()]
    if (replies.length < MIN_DISTINCT_AUTHORS) continue

    const timestamps = replies.map((r) => r.createdAt.getTime())
    const spanHours = (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60)
    if (spanHours > WINDOW_HOURS) continue

    const similarity = averagePairwiseSimilarity(replies.map((r) => r.fullText))
    if (similarity < SIMILARITY_THRESHOLD) continue

    swarmSizeByTarget.set(targetTweetId, replies.length)
    memberAccountsByTarget.set(targetTweetId, new Set(replies.map((r) => r.accountId)))
  }

  return {
    swarmSizeFor(accountId, tweetId) {
      const members = memberAccountsByTarget.get(tweetId)
      if (!members?.has(accountId)) return 0
      return swarmSizeByTarget.get(tweetId) ?? 0
    },
  }
}
