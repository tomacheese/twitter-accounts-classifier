import { Prisma, type PrismaClient } from '../generated/prisma'
import { CRAWL_LIMITS } from '../config/crawl-limits'

export interface ForeignVideoSourceBackfillCandidateOptions {
  afterId?: string
  limit: number
}

export interface ForeignVideoSourceBackfillCandidatePage {
  accountIds: string[]
  nextAfterId?: string
}

interface CandidateRow {
  accountId: string
}

/**
 * 直近 `recentTweetsPerAccount` 件の Tweet に `foreignVideoSourceCount` が未集計 (NULL) のものを含む account を、
 * keyset pagination で返す。
 * `recent-tweets-backfill-repository.ts` と同じく LATERAL + LIMIT 1 の fence で probe し、
 * optimizer による semi-join への平坦化を防ぐ。
 * 判定を全履歴ではなく直近 `recentTweetsPerAccount` 件に絞るのは、
 * 再取得で更新できるのが同じ範囲の Tweet だけであり、
 * 絞らないと更新不能な古い NULL だけが残る account が恒久的に候補化してしまうためである。
 * @param prisma - Prisma クライアント
 * @param options - strict cursor とページ件数
 * @returns account ID と、後続ページが存在する場合のみ次の cursor
 */
export async function selectForeignVideoSourceBackfillCandidates(
  prisma: PrismaClient,
  options: ForeignVideoSourceBackfillCandidateOptions,
): Promise<ForeignVideoSourceBackfillCandidatePage> {
  const cursorCondition =
    options.afterId === undefined ? Prisma.empty : Prisma.sql`AND a."id" > ${options.afterId}`
  const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT a."id" AS "accountId"
    FROM "Account" AS a
    CROSS JOIN LATERAL (
      SELECT 1
      FROM (
        SELECT t."foreignVideoSourceCount"
        FROM "Tweet" AS t
        WHERE t."accountId" = a."id"
        ORDER BY t."createdAt" DESC
        LIMIT ${CRAWL_LIMITS.recentTweetsPerAccount}
      ) AS "recentTweet"
      WHERE "recentTweet"."foreignVideoSourceCount" IS NULL
      LIMIT 1
    ) AS "nullMatch"
    WHERE true
      ${cursorCondition}
    ORDER BY a."id" ASC
    LIMIT ${options.limit + 1}
  `)

  const accountIds = rows.map((row) => row.accountId).slice(0, options.limit)
  if (rows.length <= options.limit) return { accountIds }
  return { accountIds, nextAfterId: accountIds.at(-1) }
}
