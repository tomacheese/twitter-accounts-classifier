import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildAccountSummary } from './build-account-summary'

describe('buildAccountSummary', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.accountSummaryCurrent.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.account.deleteMany()
  })

  it('ページサイズを超える件数の Account でも全件が新 generationId で作られる', async () => {
    const accounts = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        prisma.account.create({
          data: {
            id: `account-${randomUUID()}`,
            screenName: `alice_${index}`,
            displayName: `Alice ${index}`,
            followersCount: 0,
            followingCount: 0,
            tweetCount: 0,
            accountCreatedAt: new Date(),
          },
        }),
      ),
    )

    const generationId = `generation-${randomUUID()}`
    const result = await buildAccountSummary(prisma, {
      generationId,
      sourceWatermarkAt: new Date(),
      pageSize: 2,
    })

    expect(result.rowCount).toBe(5)

    const rows = await prisma.accountSummaryCurrent.findMany({ where: { generationId } })
    expect(rows).toHaveLength(5)
    expect(rows.map((row) => row.accountId).toSorted()).toEqual(
      accounts.map((account) => account.id).toSorted(),
    )
  })
})
