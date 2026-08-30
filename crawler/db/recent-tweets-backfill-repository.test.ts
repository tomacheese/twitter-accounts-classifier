import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient, type Prisma } from '../generated/prisma'
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
})

describe('selectRecentTweetsBackfillCandidates query shape', () => {
  it('対象ラベルごとに Account への JOIN・未試行条件・cursor を branch 内の LIMIT より前に適用してから UNION する', async () => {
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
    expect(candidateSql).toContain('UNION')
    expect(candidateSql).toContain('"labelDefinitionId" =')
    expect(candidateSql).toContain('"evaluable" = false')
    expect(candidateSql).toContain('INNER JOIN "Account" AS a ON a."id" = latest."accountId"')
    expect(candidateSql).toContain('a."lastRecentTweetsAttemptedAt" IS NULL')
    // branch 4本分 + 最終sentinel分で LIMIT が計5箇所必要 (branch内が先、外側の再sentinelが最後)。
    expect(candidateSql.match(/LIMIT/g)).toHaveLength(5)
    expect(candidateSql).not.toContain('CROSS JOIN LATERAL')
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
