import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Prisma, PrismaClient } from '../generated/prisma'
import { selectRecentTweetsBackfillCandidates } from './recent-tweets-backfill-repository'

const prisma = new PrismaClient()

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
  it('Account を起点に LATERAL fence 付き EXISTS 相当で対象ラベルの有無を probe する', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'ld-bot' }, { id: 'ld-rf' }, { id: 'ld-rh' }, { id: 'ld-ai' }])
      .mockResolvedValueOnce([])
    const mockPrisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await selectRecentTweetsBackfillCandidates(mockPrisma, { limit: 2 })

    const definitionLookupSql = (queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join(
      '',
    )
    expect(definitionLookupSql).toContain('FROM "LabelDefinition"')
    expect(definitionLookupSql).toContain('"key" IN')

    const candidateSql = (queryRaw.mock.calls[1][0] as { strings: string[] }).strings.join('')
    // 起点は AccountLabelLatest ではなく Account でなければ、
    // backfill 進行に伴う試行済み prefix の skip 量増加という残課題が再発する。
    expect(candidateSql).toContain('FROM "Account" AS a')
    expect(candidateSql).toContain('CROSS JOIN LATERAL')
    expect(candidateSql).toContain('"labelDefinitionId" IN')
    expect(candidateSql).toContain('"evaluable" = false')
    expect(candidateSql).toContain('WHERE a."lastRecentTweetsAttemptedAt" IS NULL')
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
    CREATE TEMPORARY TABLE "Account" (
      "id" text PRIMARY KEY,
      "lastRecentTweetsAttemptedAt" timestamptz
    ) ON COMMIT DROP
  `
  await tx.$executeRaw`
    CREATE TEMPORARY TABLE "LabelDefinition" (
      "id" text PRIMARY KEY,
      "key" text NOT NULL UNIQUE
    ) ON COMMIT DROP
  `
  await tx.$executeRaw`
    CREATE TEMPORARY TABLE "AccountLabelLatest" (
      "accountId" text NOT NULL,
      "labelDefinitionId" text NOT NULL,
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
    INSERT INTO "Account" ("id", "lastRecentTweetsAttemptedAt")
    VALUES (${id}, ${attemptedAt})
  `
}

async function seedSyntheticLatestLabel(
  tx: Prisma.TransactionClient,
  accountId: string,
  labelDefinitionId: string,
  evaluable: boolean,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "evaluable")
    VALUES (${accountId}, ${labelDefinitionId}, ${evaluable})
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
        const ids = {
          accountA: `synthetic_recent_backfill_${runId}_a`,
          accountB: `synthetic_recent_backfill_${runId}_b`,
          accountC: `synthetic_recent_backfill_${runId}_c`,
          attempted: `synthetic_recent_backfill_${runId}_d_attempted`,
          evaluable: `synthetic_recent_backfill_${runId}_e_evaluable`,
          wrongLabel: `synthetic_recent_backfill_${runId}_f_wrong_label`,
          noLabel: `synthetic_recent_backfill_${runId}_g_no_label`,
        }
        for (const [key, id] of Object.entries(ids)) {
          await seedSyntheticAccount(tx, id, { attempted: key === 'attempted' })
        }

        const botDefinitionId = `synthetic_definition_${runId}_bot`
        const replyFarmingDefinitionId = `synthetic_definition_${runId}_reply_farming`
        const replyHijackDefinitionId = `synthetic_definition_${runId}_reply_hijack`
        const aiMediaDefinitionId = `synthetic_definition_${runId}_ai_media`
        const wrongDefinitionId = `synthetic_definition_${runId}_wrong`
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
    it('試行済み prefix が伸びても Account 側は未試行分の部分 index からのみ読む', async () => {
      let assertionsCompleted = false
      try {
        await prisma.$transaction(async (tx) => {
          const runId = randomUUID().replaceAll('-', '')
          const botDefinitionId = `synthetic_definition_${runId}_bot`
          await tx.$executeRaw`
          INSERT INTO "LabelDefinition" ("id", "key", "description")
          VALUES (${botDefinitionId}, ${'bot'}, ${'synthetic'})
        `
          // 低密度の evaluable=false 付き account を大量に試行済みとして敷き、
          // production の「進行済み prefix」を再現する。
          await tx.$executeRaw`
          INSERT INTO "Account" (
            "id", "screenName", "displayName", "followersCount", "followingCount", "tweetCount",
            "accountCreatedAt", "updatedAt", "lastRecentTweetsAttemptedAt"
          )
          SELECT
            'synthetic_recent_backfill_' || ${runId} || '_attempted_' || lpad(g::text, 6, '0'),
            'synthetic_user_' || g, 'Synthetic User ' || g, 0, 0, 0, now(), now(), now()
          FROM generate_series(1, 2000) AS g
        `
          await tx.$executeRaw`
          INSERT INTO "AccountLabelLatest" (
            "accountId", "labelDefinitionId", "value", "confidence", "reason", "method",
            "ruleVersion", "evaluable", "labeledAt"
          )
          SELECT
            'synthetic_recent_backfill_' || ${runId} || '_attempted_' || lpad(g::text, 6, '0'),
            ${botDefinitionId}, false, 0, 'synthetic', 'synthetic', 'v1', false, now()
          FROM generate_series(1, 2000) AS g
          WHERE g % 10 = 0
        `
          const candidateId = `synthetic_recent_backfill_${runId}_zzz_candidate`
          await tx.$executeRaw`
          INSERT INTO "Account" (
            "id", "screenName", "displayName", "followersCount", "followingCount", "tweetCount",
            "accountCreatedAt", "updatedAt", "lastRecentTweetsAttemptedAt"
          )
          VALUES (${candidateId}, 'synthetic_candidate', 'Synthetic Candidate', 0, 0, 0, now(), now(), NULL)
        `
          await tx.$executeRaw`
          INSERT INTO "AccountLabelLatest" (
            "accountId", "labelDefinitionId", "value", "confidence", "reason", "method",
            "ruleVersion", "evaluable", "labeledAt"
          )
          VALUES (${candidateId}, ${botDefinitionId}, false, 0, 'synthetic', 'synthetic', 'v1', false, now())
        `

          let capturedCandidateSql: Prisma.Sql | undefined
          const capturingClient = {
            $queryRaw: async (sql: Prisma.Sql) => {
              if (sql.strings.join('').includes('FROM "Account" AS a')) capturedCandidateSql = sql
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
          // Account 側が Account_recent_tweets_unattempted_idx からの Index Scan であれば、
          // 未試行分のみを読み、試行済み prefix の長さに比例した skip は発生しない。
          expect(plan).toContain('Account_recent_tweets_unattempted_idx')
          expect(plan).not.toContain('Account_pkey')

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
