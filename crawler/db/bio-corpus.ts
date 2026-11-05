import type { PrismaClient } from '../generated/prisma'
import type { BioCorpusEntry } from '../labels/bio-duplicate-index'

// 件数上限は reply-corpus.ts の REPLY_CORPUS_LIMIT と同じ考え方で、
// 時間窓ではなく既存の take ベースの上限に合わせる。
const BIO_CORPUS_LIMIT = 20_000

/**
 * @param prisma - Prisma クライアント
 * @param watermark - この時刻以前に収集されたアカウントのみを対象にする
 * @returns 収集日時が新しい順の bio コーパス
 */
export async function loadBioCorpus(
  prisma: PrismaClient,
  watermark: Date,
): Promise<BioCorpusEntry[]> {
  const states = await prisma.accountCrawlState.findMany({
    where: { lastCrawledAt: { lte: watermark }, account: { bio: { not: null } } },
    orderBy: [{ lastCrawledAt: 'desc' }, { accountId: 'desc' }],
    take: BIO_CORPUS_LIMIT,
    select: { accountId: true, account: { select: { bio: true } } },
  })
  return states.flatMap((state) =>
    state.account.bio === null ? [] : [{ accountId: state.accountId, bio: state.account.bio }],
  )
}
