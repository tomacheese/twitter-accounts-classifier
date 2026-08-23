import { Prisma, type PrismaClient } from '../generated/prisma'

export const RECENT_TWEETS_BACKFILL_LABEL_KEYS = [
  'bot',
  'reply_farming',
  'reply_hijack_swarm',
  'tweet_ai_generated_media',
] as const

export interface RecentTweetsBackfillCandidateOptions {
  afterId?: string
  limit: number
}

export interface RecentTweetsBackfillCandidatePage {
  accountIds: string[]
  nextAfterId?: string
}

interface CandidateRow {
  accountId: string
}

/**
 * recent tweets が未取得で、対象ラベルを評価できなかった account を keyset pagination で返す。
 * @param prisma - Prisma クライアント
 * @param options - strict cursor とページ件数
 * @returns account ID と、後続ページが存在する場合のみ次の cursor
 */
export async function selectRecentTweetsBackfillCandidates(
  prisma: PrismaClient,
  options: RecentTweetsBackfillCandidateOptions,
): Promise<RecentTweetsBackfillCandidatePage> {
  const cursorCondition =
    options.afterId === undefined ? Prisma.empty : Prisma.sql`AND a."id" > ${options.afterId}`
  const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT DISTINCT a."id" AS "accountId"
    FROM "Account" AS a
    INNER JOIN "AccountLabelLatest" AS latest
      ON latest."accountId" = a."id"
    INNER JOIN "LabelDefinition" AS definition
      ON definition."id" = latest."labelDefinitionId"
    WHERE a."lastRecentTweetsAttemptedAt" IS NULL
      AND latest."evaluable" = false
      AND definition."key" IN (${Prisma.join(RECENT_TWEETS_BACKFILL_LABEL_KEYS)})
      ${cursorCondition}
    ORDER BY a."id" ASC
    LIMIT ${options.limit + 1}
  `)

  const distinctAccountIds = [...new Set(rows.map((row) => row.accountId))]
  const accountIds = distinctAccountIds.slice(0, options.limit)
  if (distinctAccountIds.length <= options.limit) return { accountIds }
  return { accountIds, nextAfterId: accountIds.at(-1) }
}
