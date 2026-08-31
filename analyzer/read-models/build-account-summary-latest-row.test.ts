import { describe, expect, it, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import {
  findLabelsAtWatermarkForAccount,
  findPreviousLabelAtWatermarkForAccount,
} from './build-account-summary-latest-row'

describe.skipIf(!process.env.DATABASE_URL)('findLabelsAtWatermarkForAccount', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.accountLabel.deleteMany()
    await prisma.labelDefinition.deleteMany()
    await prisma.block.deleteMany()
    await prisma.account.deleteMany()
  })

  it('AccountLabel.evaluable の実値を evaluable として返す', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_watermark_evaluable',
        screenName: 'frank',
        displayName: 'Frank',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_label_watermark_evaluable', description: 'テスト用ラベル' },
    })
    const labeledAt = new Date('2026-01-01T00:00:00Z')
    await prisma.accountLabel.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.9,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        evaluable: false,
        labeledAt,
      },
    })

    const rows = await findLabelsAtWatermarkForAccount(
      prisma,
      account.id,
      new Date('2026-01-02T00:00:00Z'),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].evaluable).toBe(false)
  })

  it('findPreviousLabelAtWatermarkForAccount も evaluable の実値を返す', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_watermark_previous_evaluable',
        screenName: 'grace',
        displayName: 'Grace',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_label_watermark_previous_evaluable', description: 'テスト用ラベル' },
    })
    await prisma.accountLabel.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.9,
        reason: 'r_old',
        method: 'rule',
        ruleVersion: 'v1',
        evaluable: false,
        labeledAt: new Date('2026-01-01T00:00:00Z'),
      },
    })
    await prisma.accountLabel.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: false,
        confidence: 0.1,
        reason: 'r_new',
        method: 'rule',
        ruleVersion: 'v1',
        evaluable: true,
        labeledAt: new Date('2026-01-02T00:00:00Z'),
      },
    })

    const rows = await findPreviousLabelAtWatermarkForAccount(
      prisma,
      account.id,
      new Date('2026-01-03T00:00:00Z'),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe('r_old')
    expect(rows[0].evaluable).toBe(false)
  })
})
