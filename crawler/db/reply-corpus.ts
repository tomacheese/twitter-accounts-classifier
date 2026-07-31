import type { PrismaClient } from '../generated/prisma'
import type { ReplyHijackCorpusEntry } from '../labels/reply-hijack-index'

// Bounded by row count (matching this project's existing `take`-based limits elsewhere)
// rather than a date window: the current reply-tweet volume (a few thousand rows) is
// small enough that a straight recency cap is simpler than introducing a new
// time-window concept.
const REPLY_CORPUS_LIMIT = 20_000

/**
 * Loads a bounded corpus of reply tweets across all accounts, most recent first. The
 * returned shape is a superset of `ReplyCorpusEntry` (see
 * `crawler/labels/duplicate-reply-index.ts`), so this one loader feeds both
 * `buildDuplicateReplyIndex` and `buildReplyHijackIndex` (see
 * `crawler/labels/reply-hijack-index.ts`).
 * @param prisma - the Prisma client to query
 * @returns the reply corpus, most recently collected first
 */
export async function loadReplyCorpus(prisma: PrismaClient): Promise<ReplyHijackCorpusEntry[]> {
  return prisma.tweet.findMany({
    where: { isReply: true },
    orderBy: { collectedAt: 'desc' },
    take: REPLY_CORPUS_LIMIT,
    select: { accountId: true, fullText: true, inReplyToTweetId: true, createdAt: true },
  })
}
