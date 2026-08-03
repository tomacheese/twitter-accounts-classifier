import type { PrismaClient } from '../generated/prisma'
import type { ReplyHijackCorpusEntry } from '../labels/reply-hijack-index'

// 日付レンジではなく件数で上限を区切る: 新しい時間窓の概念を導入するより、
// 既存の `take` ベースの上限に合わせるほうがシンプルなため。
const REPLY_CORPUS_LIMIT = 20_000

/**
 * @param prisma - Prisma クライアント
 * @returns 収集日時が新しい順の返信コーパス
 */
export async function loadReplyCorpus(prisma: PrismaClient): Promise<ReplyHijackCorpusEntry[]> {
  return prisma.tweet.findMany({
    where: { isReply: true },
    orderBy: { collectedAt: 'desc' },
    take: REPLY_CORPUS_LIMIT,
    select: { accountId: true, fullText: true, inReplyToTweetId: true, createdAt: true },
  })
}
