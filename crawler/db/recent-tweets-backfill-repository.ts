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
 * 未試行 account 側から対象ラベルの有無を probe する設計は、候補密度が低い production では
 * statement_timeout を超過した。対象ラベルごとに絞り込んだ branch を先に作り UNION する。
 * branch 内で Account への JOIN・未試行条件・cursor を LIMIT より前に適用しないと、
 * そのラベルの上位 limit+1 件が試行済みだった場合に本来の候補を取りこぼす。
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
  const labelBranches = Prisma.join(
    definitions.map(
      (definition) => Prisma.sql`(
        SELECT a."id" AS "accountId"
        FROM "AccountLabelLatest" AS latest
        INNER JOIN "Account" AS a ON a."id" = latest."accountId"
        WHERE latest."labelDefinitionId" = ${definition.id}
          AND latest."evaluable" = false
          AND a."lastRecentTweetsAttemptedAt" IS NULL
          ${cursorCondition}
        ORDER BY a."id" ASC
        LIMIT ${options.limit + 1}
      )`,
    ),
    ' UNION ',
  )
  const rows = await prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT "accountId"
    FROM (${labelBranches}) AS "candidate"
    ORDER BY "accountId" ASC
    LIMIT ${options.limit + 1}
  `)

  const accountIds = rows.map((row) => row.accountId).slice(0, options.limit)
  if (rows.length <= options.limit) return { accountIds }
  return { accountIds, nextAfterId: accountIds.at(-1) }
}
