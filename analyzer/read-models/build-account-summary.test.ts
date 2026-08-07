import { describe, it, expect, beforeEach, afterAll } from 'vitest'
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
    await prisma.blockStateChange.deleteMany()
    await prisma.block.deleteMany()
    await prisma.account.deleteMany()
  })

  // 他のテストファイルは AccountLabelLatest を消さずに Account/LabelDefinition を消すため、
  // このファイルで作った紐づけを残すと相手側の後始末が外部キーで失敗する。
  afterAll(async () => {
    await prisma.accountSummaryCurrent.deleteMany()
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

  it('activeLabelKeys には LabelDefinition の key が入る', async () => {
    const accountId = `account-${randomUUID()}`
    await prisma.account.create({
      data: {
        id: accountId,
        screenName: 'bob',
        displayName: 'Bob',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelKey = `spam_${randomUUID().slice(0, 8)}`
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: labelKey, description: 'テスト用ラベル' },
    })
    await prisma.accountLabelLatest.create({
      data: {
        accountId,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 1,
        reason: 'test',
        method: 'rule',
        ruleVersion: 'v1',
        labeledAt: new Date(),
      },
    })

    const generationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, { generationId, sourceWatermarkAt: new Date() })

    const row = await prisma.accountSummaryCurrent.findFirstOrThrow({
      where: { generationId, accountId },
    })
    expect(row.activeLabelKeys).toEqual([labelKey])
    expect(row.activeLabelCount).toBe(1)
  })
})
