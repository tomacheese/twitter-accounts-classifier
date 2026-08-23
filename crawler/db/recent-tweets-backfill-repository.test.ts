import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { PrismaClient, type Prisma } from '../generated/prisma'
import { selectRecentTweetsBackfillCandidates } from './recent-tweets-backfill-repository'

const prisma = new PrismaClient()

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
  it('executes DISTINCT joins, filters, strict cursor, and sentinel pagination against synthetic rows', async () => {
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
