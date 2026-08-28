import type { PrismaClient } from '../generated/prisma'

// 既存の reply-corpus.ts と同じく、新しい時間窓の概念を導入せず件数で上限を区切る。
const SELF_REPLY_PROMO_CORPUS_LIMIT = 20_000

export interface SelfReplyPromoCorpusEntry {
  id: string
  accountId: string
  inReplyToTweetId: string | null
  fullText: string
  expandedUrls: string[]
  createdAt: Date
  /** 誘導先が自分自身の X status でないかを判定するために必要な、この self-reply 投稿者の screenName。 */
  authorScreenName: string
}

export interface RootCandidateEntry {
  id: string
  accountId: string
  isReply: boolean
  isRetweet: boolean
}

/**
 * @param prisma - Prisma クライアント
 * @param watermark - この時刻以前に収集された self-reply のみを対象にする
 * @returns 自己返信コーパスと、そのチェーンを遡って解決した root 候補コーパス
 */
export async function loadSelfReplyPromoCorpus(
  prisma: PrismaClient,
  watermark: Date,
): Promise<{ selfReplyCorpus: SelfReplyPromoCorpusEntry[]; rootCorpus: RootCandidateEntry[] }> {
  const rows = await prisma.tweet.findMany({
    where: { isReply: true, isAuthorReply: true, collectedAt: { lte: watermark } },
    orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
    take: SELF_REPLY_PROMO_CORPUS_LIMIT,
    select: {
      id: true,
      accountId: true,
      inReplyToTweetId: true,
      fullText: true,
      expandedUrls: true,
      createdAt: true,
      account: { select: { screenName: true } },
    },
  })
  const selfReplyCorpus: SelfReplyPromoCorpusEntry[] = rows.map(({ account, ...tweet }) => ({
    ...tweet,
    authorScreenName: account.screenName,
  }))

  const byId = new Map(selfReplyCorpus.map((entry) => [entry.id, entry]))
  const rootCandidateIds = new Set<string>()
  for (const entry of selfReplyCorpus) {
    let parentId = entry.inReplyToTweetId
    while (parentId !== null && byId.has(parentId)) {
      parentId = byId.get(parentId)?.inReplyToTweetId ?? null
    }
    if (parentId !== null) rootCandidateIds.add(parentId)
  }

  const rootCorpus =
    rootCandidateIds.size === 0
      ? []
      : await prisma.tweet.findMany({
          where: { id: { in: [...rootCandidateIds] } },
          select: { id: true, accountId: true, isReply: true, isRetweet: true },
        })

  return { selfReplyCorpus, rootCorpus }
}
