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
  it('AccountLabelLatest_backfill_label_evaluable_idx を期待する列順・述語で定義する', () => {
    // tsconfig の module は CommonJS のため import.meta は使えない。
    // eslint-disable-next-line unicorn/prefer-module
    const migrationsDir = path.join(__dirname, '../../prisma/migrations')
    const dirs = readdirSync(migrationsDir).filter((d) =>
      d.includes('add_recent_tweets_backfill_label_evaluable_index'),
    )
    expect(dirs.length).toBe(1)
    const sql = readFileSync(path.join(migrationsDir, dirs[0], 'migration.sql'), 'utf8')
    expect(sql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabelLatest_backfill_label_evaluable_idx"/,
    )
    expect(sql).toMatch(/ON "AccountLabelLatest"/)
    expect(sql).toMatch(/\("labelDefinitionId", "accountId"\)/)
    expect(sql).toMatch(/WHERE "evaluable" = false/)
  })

  it('AccountCrawlState_recent_tweets_unattempted_idx を baseline で期待する列・述語で定義する', () => {
    // eslint-disable-next-line unicorn/prefer-module
    const sql = readFileSync(path.join(__dirname, '../../prisma/baseline/baseline.sql'), 'utf8')
    expect(sql).toMatch(
      /CREATE INDEX "AccountCrawlState_recent_tweets_unattempted_idx"\s+ON "AccountCrawlState" \("accountId"\)\s+WHERE "lastRecentTweetsAttemptedAt" IS NULL;/,
    )
  })
})

describe('selectRecentTweetsBackfillCandidates query shape', () => {
  it('AccountCrawlState を起点に LATERAL fence 付き EXISTS 相当で対象ラベルの有無を probe する', async () => {
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
    // 起点は AccountLabelLatest ではなく AccountCrawlState でなければ、
    // backfill 進行に伴う試行済み prefix の skip 量増加という残課題が再発する。
    expect(candidateSql).toContain('FROM "AccountCrawlState" AS a')
    expect(candidateSql).toContain('CROSS JOIN LATERAL')
    expect(candidateSql).toContain('"labelDefinitionId" IN')
    expect(candidateSql).toContain('"evaluable" = false')
    expect(candidateSql).toContain('WHERE a."lastRecentTweetsAttemptedAt" IS NULL')
    expect(candidateSql).not.toContain('FROM "Account" ')
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
    CREATE TEMPORARY TABLE "AccountLabelLatest" (
      "accountId" bigint NOT NULL,
      "labelDefinitionId" smallint NOT NULL,
      "evaluable" boolean NOT NULL,
      PRIMARY KEY ("accountId", "labelDefinitionId")
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

async function seedSyntheticLatestLabel(
  tx: Prisma.TransactionClient,
  accountId: string,
  labelDefinitionId: number,
  evaluable: boolean,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "evaluable")
    VALUES (${accountId}::bigint, ${labelDefinitionId}::smallint, ${evaluable})
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

        await seedSyntheticLatestLabel(tx, ids.accountA, botDefinitionId, false)
        await seedSyntheticLatestLabel(tx, ids.accountA, replyFarmingDefinitionId, false)
        await seedSyntheticLatestLabel(tx, ids.accountB, replyHijackDefinitionId, false)
        await seedSyntheticLatestLabel(tx, ids.accountC, aiMediaDefinitionId, false)
        await seedSyntheticLatestLabel(tx, ids.attempted, botDefinitionId, false)
        await seedSyntheticLatestLabel(tx, ids.evaluable, botDefinitionId, true)
        await seedSyntheticLatestLabel(tx, ids.wrongLabel, wrongDefinitionId, false)

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
          await tx.$executeRaw`
            CREATE TEMPORARY TABLE "AccountLabelLatest" (
              "accountId" bigint NOT NULL,
              "labelDefinitionId" smallint NOT NULL,
              "evaluable" boolean NOT NULL,
              PRIMARY KEY ("accountId", "labelDefinitionId")
            ) ON COMMIT DROP
          `
          await tx.$executeRaw`
            INSERT INTO "LabelDefinition" ("key", "description")
            VALUES ('bot', 'synthetic')
            ON CONFLICT ("key") DO NOTHING
          `
          const [{ id: botDefinitionId }] = await tx.$queryRaw<{ id: number }[]>`
            SELECT "id" FROM "LabelDefinition" WHERE "key" = 'bot'
          `
          // 低密度の evaluable=false 付き account を大量に試行済みとして敷き、
          // production の「進行済み prefix」を再現する。
          await tx.$executeRaw`
            INSERT INTO "Account" (
              "id", "screenName", "displayName", "followersCount", "followingCount", "tweetCount",
              "accountCreatedAt", "updatedAt"
            )
            SELECT
              ${baseId}::bigint + g, 'synthetic_user_' || g, 'Synthetic User ' || g, 0, 0, 0,
              now(), now()
            FROM generate_series(1, 20000) AS g
          `
          await tx.$executeRaw`
            INSERT INTO "AccountCrawlState" ("accountId", "lastRecentTweetsAttemptedAt")
            SELECT ${baseId}::bigint + g, now()
            FROM generate_series(1, 20000) AS g
          `
          await tx.$executeRaw`
            INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "evaluable")
            SELECT ${baseId}::bigint + g, ${botDefinitionId}::smallint, false
            FROM generate_series(1, 20000) AS g
            WHERE g % 10 = 0
          `
          const candidateId = String(baseId + 20_001n)
          await tx.$executeRaw`
            INSERT INTO "Account" (
              "id", "screenName", "displayName", "followersCount", "followingCount", "tweetCount",
              "accountCreatedAt", "updatedAt"
            )
            VALUES (
              ${candidateId}::bigint, 'synthetic_candidate', 'Synthetic Candidate', 0, 0, 0,
              now(), now()
            )
          `
          await tx.$executeRaw`
            INSERT INTO "AccountCrawlState" ("accountId", "lastRecentTweetsAttemptedAt")
            VALUES (${candidateId}::bigint, NULL)
          `
          await tx.$executeRaw`
            INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "evaluable")
            VALUES (${candidateId}::bigint, ${botDefinitionId}::smallint, false)
          `
          // planner の統計情報を fixture 挿入直後の実データに合わせておかないと、
          // 共有 DB での実行順序次第で古い統計のまま EXPLAIN が別の plan を選び、
          // 期待した index の使用を検証できなくなる。
          await tx.$executeRaw`ANALYZE "AccountCrawlState", "AccountLabelLatest"`

          let capturedCandidateSql: Prisma.Sql | undefined
          const capturingClient = {
            $queryRaw: async (sql: Prisma.Sql) => {
              if (sql.strings.join('').includes('FROM "AccountCrawlState" AS a')) {
                capturedCandidateSql = sql
              }
              return (tx as unknown as PrismaClient).$queryRaw(sql)
            },
          } as unknown as PrismaClient

          await expect(
            selectRecentTweetsBackfillCandidates(capturingClient, { limit: 5 }),
          ).resolves.toEqual({ accountIds: [candidateId] })
          if (capturedCandidateSql === undefined) throw new Error('candidate SQL was not captured')

          const explainRows = await tx.$queryRaw<{ 'QUERY PLAN': unknown[] }[]>(
            Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${capturedCandidateSql}`,
          )
          const plan = JSON.stringify(explainRows[0]['QUERY PLAN'])
          // 部分 index からの Index Scan であれば、未試行分のみを読み、
          // 試行済み prefix の長さに比例した skip は発生しない。
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
