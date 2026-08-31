import { Prisma, type PrismaClient } from '../generated/prisma'
import { CRAWL_LIMITS } from '../config/crawl-limits'

export const CARD_DESTINATION_URL_BACKFILL_LABEL_KEY = 'ad_pr_hashtag'

export interface CardDestinationUrlBackfillCandidateOptions {
  afterId?: string
  limit: number
}

export interface CardDestinationUrlBackfillCandidatePage {
  accountIds: string[]
  nextAfterId?: string
}

interface CandidateRow {
  accountId: string
}

interface DefinitionIdRow {
  id: string
}

/**
 * `ad_pr_hashtag=true` の account のうち、
 * 直近 `recentTweetsPerAccount` 件の Tweet に Card 未評価のものを含むものを keyset pagination で返す。
 * `recent-tweets-backfill-repository.ts` と同じく LATERAL + LIMIT 1 の fence で各条件を probe し、
 * optimizer による semi-join への平坦化を防ぐ。
 * 未評価判定を全履歴ではなく直近 `recentTweetsPerAccount` 件に絞るのは、
 * ラベル評価自体が同じ範囲の Tweet しか見ないためであり、
 * 絞らないと評価対象外の古い未評価 Tweet だけが残る account が backfill 対象として恒久的に候補化してしまう。
 * `ad_pr_hashtag=true` の account 数自体が全体よりかなり小さいため、
 * `Tweet(accountId, cardDestinationUrlsEvaluated)` 専用の部分 index は追加していない。
 * この backfill が遅いと分かったら追加する。
 * @param prisma - Prisma クライアント
 * @param options - strict cursor とページ件数
 * @returns account ID と、後続ページが存在する場合のみ次の cursor
 */
export async function selectCardDestinationUrlBackfillCandidates(
  prisma: PrismaClient,
  options: CardDestinationUrlBackfillCandidateOptions,
): Promise<CardDestinationUrlBackfillCandidatePage> {
  const definitions = await prisma.$queryRaw<DefinitionIdRow[]>(Prisma.sql`
    SELECT "id"
    FROM "LabelDefinition"
    WHERE "key" = ${CARD_DESTINATION_URL_BACKFILL_LABEL_KEY}
  `)
  if (definitions.length === 0) return { accountIds: [] }
  const definitionId = definitions[0].id

  const cursorCondition =
    options.afterId === undefined ? Prisma.empty : Prisma.sql`AND a."id" > ${options.afterId}`
  const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT a."id" AS "accountId"
    FROM "Account" AS a
    CROSS JOIN LATERAL (
      SELECT 1
      FROM "AccountLabelLatest" AS latest
      WHERE latest."accountId" = a."id"
        AND latest."labelDefinitionId" = ${definitionId}
        AND latest."value" = true
      LIMIT 1
    ) AS "prMatch"
    CROSS JOIN LATERAL (
      SELECT 1
      FROM (
        SELECT t."cardDestinationUrlsEvaluated"
        FROM "Tweet" AS t
        WHERE t."accountId" = a."id"
        ORDER BY t."createdAt" DESC
        LIMIT ${CRAWL_LIMITS.recentTweetsPerAccount}
      ) AS "recentTweet"
      WHERE "recentTweet"."cardDestinationUrlsEvaluated" = false
      LIMIT 1
    ) AS "cardMatch"
    WHERE true
      ${cursorCondition}
    ORDER BY a."id" ASC
    LIMIT ${options.limit + 1}
  `)

  const accountIds = rows.map((row) => row.accountId).slice(0, options.limit)
  if (rows.length <= options.limit) return { accountIds }
  return { accountIds, nextAfterId: accountIds.at(-1) }
}
