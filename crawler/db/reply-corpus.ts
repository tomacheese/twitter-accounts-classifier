import type { PrismaClient } from '../generated/prisma'
import type { ReplyHijackCorpusEntry } from '../labels/reply-hijack-index'

// 日付レンジではなく件数で上限を区切る: 新しい時間窓の概念を導入するより、
// 既存の `take` ベースの上限に合わせるほうがシンプルなため。
const REPLY_CORPUS_LIMIT = 20_000

/**
 * @param prisma - Prisma クライアント
 * @param watermark - この時刻以前に収集された reply のみを対象にする
 * @returns 収集日時が新しい順の返信コーパス。`collectedAt` の tie は `id` 降順で総順序化する
 */
export async function loadReplyCorpus(
  prisma: PrismaClient,
  watermark: Date,
): Promise<ReplyHijackCorpusEntry[]> {
  return prisma.tweet
    .findMany({
      where: { isReply: true, collectedAt: { lte: watermark } },
      orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
      take: REPLY_CORPUS_LIMIT,
      select: {
        id: true,
        accountId: true,
        fullText: true,
        inReplyToTweetId: true,
        createdAt: true,
      },
    })
    .then((tweets) =>
      tweets.map(({ id, ...tweet }) => ({
        tweetId: id,
        ...tweet,
      })),
    )
}
