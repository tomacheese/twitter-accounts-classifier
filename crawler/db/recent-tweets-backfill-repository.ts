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
  id: string
}

/**
 * recent tweets が未取得で、対象ラベルを評価できなかった account を keyset pagination で返す。
 * AccountLabelLatest 側の evaluable=false 行を起点に Account を probe する設計は、
 * backfill 進行に対して skip 量が非有界だった。
 * Account 側の未試行行 (lastRecentTweetsAttemptedAt IS NULL) を起点にすると、
 * 試行済みになった行は部分 index から消えるため、スキャン量が未試行件数だけに比例する。
 * ただし相関 EXISTS のままだと optimizer が semi-join として平坦化し、
 * 結局 AccountLabelLatest 側の全体 scan に戻ってしまうため、
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
    options.afterId === undefined ? Prisma.empty : Prisma.sql`AND a."id" > ${options.afterId}`
  const definitionIds = Prisma.join(definitions.map((definition) => definition.id))
  const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT a."id" AS "accountId"
    FROM "Account" AS a
    CROSS JOIN LATERAL (
      SELECT 1
      FROM "AccountLabelLatest" AS latest
      WHERE latest."accountId" = a."id"
        AND latest."labelDefinitionId" IN (${definitionIds})
        AND latest."evaluable" = false
      LIMIT 1
    ) AS "match"
    WHERE a."lastRecentTweetsAttemptedAt" IS NULL
      ${cursorCondition}
    ORDER BY a."id" ASC
    LIMIT ${options.limit + 1}
  `)

  const accountIds = rows.map((row) => row.accountId).slice(0, options.limit)
  if (rows.length <= options.limit) return { accountIds }
  return { accountIds, nextAfterId: accountIds.at(-1) }
}
