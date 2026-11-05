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

interface DefinitionIdRow {
  id: number
}

/**
 * recent tweets が未取得で、対象ラベルを評価できなかった account を keyset pagination で返す。
 * 「評価不能」は recent tweets の未取得とは限らない (bot はサンプル数でも評価不能になる) ため、
 * 未試行の AccountCrawlState (lastRecentTweetsAttemptedAt IS NULL) を起点に、
 * 対象ラベルの versions の符号が負 (評価不能) であることを AccountLabelState で確かめる。
 * 未試行行を起点にすると、試行済みになった行は部分 index から消えるため、
 * スキャン量が未試行件数だけに比例する。
 * ただし相関 EXISTS のままだと optimizer が semi-join として平坦化し、
 * AccountLabelState 側の全体 scan に戻ってしまうため、
 * LATERAL と LIMIT 1 で平坦化を防ぐ fence にする。
 * @param prisma - Prisma クライアント
 * @param options - strict cursor とページ件数
 * @returns account ID と、後続ページが存在する場合のみ次の cursor
 */
export async function selectRecentTweetsBackfillCandidates(
  prisma: PrismaClient,
  options: RecentTweetsBackfillCandidateOptions,
): Promise<RecentTweetsBackfillCandidatePage> {
  const definitions = await prisma.$queryRaw<DefinitionIdRow[]>(Prisma.sql`
    SELECT "id"
    FROM "LabelDefinition"
    WHERE "key" IN (${Prisma.join(RECENT_TWEETS_BACKFILL_LABEL_KEYS)})
  `)
  if (definitions.length === 0) return { accountIds: [] }

  const cursorCondition =
    options.afterId === undefined
      ? Prisma.empty
      : Prisma.sql`AND c."accountId" > ${options.afterId}::bigint`
  const definitionIds = Prisma.join(definitions.map((definition) => definition.id))
  const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT c."accountId"::text AS "accountId"
    FROM "AccountCrawlState" AS c
    CROSS JOIN LATERAL (
      SELECT 1
      FROM "AccountLabelState" AS state
      WHERE state."accountId" = c."accountId"
        AND EXISTS (
          SELECT 1
          FROM unnest(ARRAY[${definitionIds}]::smallint[]) AS d("labelDefinitionId")
          WHERE state."versions"[d."labelDefinitionId"] < 0
        )
      LIMIT 1
    ) AS "match"
    WHERE c."lastRecentTweetsAttemptedAt" IS NULL
      ${cursorCondition}
    ORDER BY c."accountId" ASC
    LIMIT ${options.limit + 1}
  `)

  const accountIds = rows.map((row) => row.accountId).slice(0, options.limit)
  if (rows.length <= options.limit) return { accountIds }
  return { accountIds, nextAfterId: accountIds.at(-1) }
}
