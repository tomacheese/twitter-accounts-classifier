import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createSyntheticId } from 'id-boundary'
import { Prisma, type PrismaClient } from '../generated/prisma'
import { getPrismaClient } from './client'
import { selectRecentTweetsBackfillCandidates } from './recent-tweets-backfill-repository'

const prisma = getPrismaClient()

describe('recent tweets backfill 部分index migration', () => {
  it('Account_recent_tweets_unattempted_idx を期待する列・述語で定義する', () => {
    // eslint-disable-next-line unicorn/prefer-module
    const migrationsDir = path.join(__dirname, '../../prisma/migrations')
    const dirs = readdirSync(migrationsDir).filter((d) =>
      d.includes('add_account_recent_tweets_unattempted_index'),
    )
    expect(dirs.length).toBe(1)
    const sql = readFileSync(path.join(migrationsDir, dirs[0], 'migration.sql'), 'utf8')
    expect(sql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "Account_recent_tweets_unattempted_idx"/,
    )
    expect(sql).toMatch(/ON "Account" \("id"\)/)
    expect(sql).toMatch(/WHERE "lastRecentTweetsAttemptedAt" IS NULL/)
  })
})

describe('selectRecentTweetsBackfillCandidates query shape', () => {
  it('AccountCrawlState を起点に LATERAL fence 付きで AccountLabelState の評価不能 (versions の負の値) を probe する', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
      .mockResolvedValueOnce([])
    const mockPrisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await selectRecentTweetsBackfillCandidates(mockPrisma, { limit: 2 })

    const definitionLookupSql = (queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join(
      '',
    )
    expect(definitionLookupSql).toContain('FROM "LabelDefinition"')
    expect(definitionLookupSql).toContain('"key" IN')

    const candidateSql = (queryRaw.mock.calls[1][0] as { strings: string[] }).strings.join('')
    // 起点は AccountLabelState ではなく未試行の AccountCrawlState でなければ、
    // backfill 進行に伴う試行済み prefix の skip 量増加という残課題が再発する。
    expect(candidateSql).toContain('FROM "AccountCrawlState" AS c')
    expect(candidateSql).toContain('CROSS JOIN LATERAL')
    expect(candidateSql).toContain('FROM "AccountLabelState" AS state')
    expect(candidateSql).toContain('state."versions"[d."labelDefinitionId"] < 0')
    expect(candidateSql).toContain('WHERE c."lastRecentTweetsAttemptedAt" IS NULL')
    // LATERAL 内の LIMIT 1 が optimizer による semi-join への平坦化を防ぐ fence、
    // 外側の LIMIT が limit+1 sentinel。
    expect(candidateSql.match(/LIMIT/g)).toHaveLength(2)
    expect(candidateSql).not.toContain('UNION')
  })

  it('対象ラベルが1件も存在しない場合は Account への問い合わせを行わずに空ページを返す', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([])
    const mockPrisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await expect(selectRecentTweetsBackfillCandidates(mockPrisma, { limit: 2 })).resolves.toEqual({
      accountIds: [],
    })
    expect(queryRaw).toHaveBeenCalledTimes(1)
  })
})

class RollbackFixture extends Error {}

interface SyntheticAccountOptions {
  attempted?: boolean
}

async function createSyntheticTables(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`
    CREATE TEMPORARY TABLE "AccountCrawlState" (
      "accountId" bigint PRIMARY KEY,
      "lastRecentTweetsAttemptedAt" timestamptz
    ) ON COMMIT DROP
  `
  await tx.$executeRaw`
    CREATE TEMPORARY TABLE "LabelDefinition" (
      "id" smallint PRIMARY KEY,
      "key" text NOT NULL UNIQUE
    ) ON COMMIT DROP
  `
  await tx.$executeRaw`
    CREATE TEMPORARY TABLE "AccountLabelState" (
      "accountId" bigint PRIMARY KEY,
      "versions" smallint[] NOT NULL
    ) ON COMMIT DROP
  `
}

async function seedSyntheticAccount(
  tx: Prisma.TransactionClient,
  id: string,
  options: SyntheticAccountOptions = {},
): Promise<void> {
  const attemptedAt = options.attempted ? new Date('2026-08-24T00:00:00Z') : null
  await tx.$executeRaw`
    INSERT INTO "AccountCrawlState" ("accountId", "lastRecentTweetsAttemptedAt")
    VALUES (${id}::bigint, ${attemptedAt})
  `
}

/** versions の添字は LabelDefinition.id (1 始まり)。負の値は評価不能、0 は未評価。 */
async function seedSyntheticLabelState(
  tx: Prisma.TransactionClient,
  accountId: string,
  versions: number[],
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "AccountLabelState" ("accountId", "versions")
    VALUES (${accountId}::bigint, ${versions}::smallint[])
  `
}

afterAll(async () => {
  await prisma.$disconnect()
})

describe.skipIf(!process.env.DATABASE_URL)('selectRecentTweetsBackfillCandidates', () => {
  it('executes joins, filters, strict cursor, and sentinel pagination against synthetic rows without duplicates', async () => {
    let assertionsCompleted = false
    try {
      await prisma.$transaction(async (tx) => {
        await createSyntheticTables(tx)
        const runId = randomUUID()
        const baseId = BigInt(createSyntheticId())
        const ids = {
          accountA: String(baseId + 1n),
          accountB: String(baseId + 2n),
          accountC: String(baseId + 3n),
          attempted: String(baseId + 4n),
          evaluable: String(baseId + 5n),
          wrongLabel: String(baseId + 6n),
          noLabel: String(baseId + 7n),
        }
        for (const [key, id] of Object.entries(ids)) {
          await seedSyntheticAccount(tx, id, { attempted: key === 'attempted' })
        }

        const botDefinitionId = 1
        const replyFarmingDefinitionId = 2
        const replyHijackDefinitionId = 3
        const aiMediaDefinitionId = 4
        const wrongDefinitionId = 5
        await tx.$executeRaw`
          INSERT INTO "LabelDefinition" ("id", "key")
          VALUES
            (${botDefinitionId}, ${'bot'}),
            (${replyFarmingDefinitionId}, ${'reply_farming'}),
            (${replyHijackDefinitionId}, ${'reply_hijack_swarm'}),
            (${aiMediaDefinitionId}, ${'tweet_ai_generated_media'}),
            (${wrongDefinitionId}, ${`synthetic_non_target_${runId}`})
        `

        // 添字は definition id。bot=1、reply_farming=2、reply_hijack_swarm=3、tweet_ai_generated_media=4。
        await seedSyntheticLabelState(tx, ids.accountA, [-1, -1])
        await seedSyntheticLabelState(tx, ids.accountB, [1, 1, -1])
        await seedSyntheticLabelState(tx, ids.accountC, [1, 1, 1, -2])
        await seedSyntheticLabelState(tx, ids.attempted, [-1])
        await seedSyntheticLabelState(tx, ids.evaluable, [1, 0, 0, 0, 0])
        await seedSyntheticLabelState(tx, ids.wrongLabel, [1, 1, 1, 1, -1])
        // 状態行がまだ無い account (noLabel) は、どのラベルも評価不能ではない。

        const transactionClient = tx as unknown as PrismaClient
        await expect(
          selectRecentTweetsBackfillCandidates(transactionClient, { limit: 2 }),
        ).resolves.toEqual({
          accountIds: [ids.accountA, ids.accountB],
          nextAfterId: ids.accountB,
        })
        await expect(
          selectRecentTweetsBackfillCandidates(transactionClient, {
            afterId: ids.accountB,
            limit: 2,
          }),
        ).resolves.toEqual({ accountIds: [ids.accountC] })

        assertionsCompleted = true
        throw new RollbackFixture()
      })
    } catch (error) {
      if (!(error instanceof RollbackFixture)) throw error
    }
    expect(assertionsCompleted).toBe(true)
  })
})

describe.skipIf(!process.env.DATABASE_URL)(
  'selectRecentTweetsBackfillCandidates EXPLAIN 契約',
  () => {
    it('試行済み prefix が伸びても AccountCrawlState 側は未試行分の部分 index からのみ読む', async () => {
      let assertionsCompleted = false
      try {
        await prisma.$transaction(async (tx) => {
          const baseId = BigInt(createSyntheticId())
          // 低密度の評価不能ラベル付き account を大量に試行済みとして敷き、
          // production の「進行済み prefix」を再現する。
          await tx.$executeRaw`
            INSERT INTO "Account" (
              "id", "screenName", "displayName", "followersCount", "followingCount", "tweetCount",
              "accountCreatedAt", "updatedAt"
            )
            SELECT ${baseId}::bigint + g, 'synthetic_user_' || g, 'Synthetic User ' || g, 0, 0, 0, now(), now()
            FROM generate_series(1, 20001) AS g
          `
          await tx.$executeRaw`
            INSERT INTO "AccountCrawlState" ("accountId", "lastRecentTweetsAttemptedAt")
            SELECT ${baseId}::bigint + g, CASE WHEN g <= 20000 THEN now() END
            FROM generate_series(1, 20001) AS g
          `
          const candidateId = String(baseId + 20_001n)
          await tx.$executeRaw`
            INSERT INTO "LabelDefinition" ("key", "description")
            VALUES ('bot', 'synthetic')
            ON CONFLICT ("key") DO NOTHING
          `
          const [{ id: botDefinitionId }] = await tx.$queryRaw<{ id: number }[]>`
            SELECT "id" FROM "LabelDefinition" WHERE "key" = 'bot'
          `
          await tx.$executeRaw`
            INSERT INTO "AccountLabelState" ("accountId", "evaluatedAt", "versions")
            SELECT ${baseId}::bigint + g, now(),
                   array_fill(0, ARRAY[${botDefinitionId}::int - 1])::smallint[] || ARRAY[-1]::smallint[]
            FROM generate_series(1, 20001) AS g
            WHERE g % 10 = 0 OR g = 20001
          `
          // planner の統計情報を fixture 挿入直後の実データに合わせておかないと、
          // 共有 DB での実行順序次第で古い統計のまま EXPLAIN が別の plan を選び、
          // 期待した index の使用を検証できなくなる。
          await tx.$executeRaw`ANALYZE "AccountCrawlState", "AccountLabelState"`

          let capturedCandidateSql: Prisma.Sql | undefined
          const capturingClient = {
            $queryRaw: async (sql: Prisma.Sql) => {
              if (sql.strings.join('').includes('FROM "AccountCrawlState" AS c')) {
                capturedCandidateSql = sql
              }
              return (tx as unknown as PrismaClient).$queryRaw(sql)
            },
          } as unknown as PrismaClient

          await expect(
            selectRecentTweetsBackfillCandidates(capturingClient, {
              afterId: String(baseId),
              limit: 5,
            }),
          ).resolves.toEqual({ accountIds: [candidateId] })
          if (capturedCandidateSql === undefined) throw new Error('candidate SQL was not captured')

          const explainRows = await tx.$queryRaw<{ 'QUERY PLAN': unknown[] }[]>(
            Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${capturedCandidateSql}`,
          )
          const plan = JSON.stringify(explainRows[0]['QUERY PLAN'])
          // 未試行分だけの部分 index からの Index Scan であれば、試行済み prefix の長さに比例した skip は発生しない。
          expect(plan).toContain('AccountCrawlState_recent_tweets_unattempted_idx')
          expect(plan).not.toContain('AccountCrawlState_pkey')
          expect(plan).not.toContain('Seq Scan')

          assertionsCompleted = true
          throw new RollbackFixture()
        })
      } catch (error) {
        if (!(error instanceof RollbackFixture)) throw error
      }
      expect(assertionsCompleted).toBe(true)
    })
  },
)
