import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildAccountSummary } from './build-account-summary'

describe.skipIf(!process.env.DATABASE_URL)('buildAccountSummary', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.accountLabelChange.deleteMany()
    await prisma.accountClassificationCurrent.deleteMany()
    await prisma.accountSummaryCurrent.deleteMany()
    await prisma.findingEvidence.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.blockStateChange.deleteMany()
    await prisma.block.deleteMany()
    await prisma.account.deleteMany()
  })

  // 他のテストファイルは AccountLabel/AccountLabelLatest を消さずに Account/LabelDefinition を消すため、
  // このファイルで作った紐づけを残すと相手側の後始末が外部キーで失敗する。
  afterAll(async () => {
    await prisma.accountLabelChange.deleteMany()
    await prisma.accountClassificationCurrent.deleteMany()
    await prisma.accountSummaryCurrent.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.account.deleteMany()
  })

  /**
   * buildAccountSummary は AccountLabelLatest ではなく AccountLabel の履歴から
   * sourceWatermarkAt 時点の値を復元するため、テストのラベル付けはこちらへ作成する。
   * @param params - 作成するラベル履歴行のパラメータ
   * @returns 作成した AccountLabel の id
   */
  async function createAccountLabel(params: {
    accountId: string
    labelDefinitionId: string
    value: boolean
    confidence: number
    reason: string
    labeledAt: Date
  }): Promise<string> {
    const row = await prisma.accountLabel.create({
      data: {
        accountId: params.accountId,
        labelDefinitionId: params.labelDefinitionId,
        value: params.value,
        confidence: params.confidence,
        reason: params.reason,
        method: 'rule',
        ruleVersion: 'v1',
        labeledAt: params.labeledAt,
      },
    })
    return row.id
  }

  /**
   * @param screenName - 作成する Account の screenName
   * @returns 作成した Account の ID
   */
  async function createAccount(screenName: string): Promise<string> {
    const accountId = `account-${randomUUID()}`
    await prisma.account.create({
      data: {
        id: accountId,
        screenName,
        displayName: screenName,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    return accountId
  }

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
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: true,
      confidence: 1,
      reason: 'test',
      labeledAt: new Date(),
    })

    const generationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, { generationId, sourceWatermarkAt: new Date() })

    const row = await prisma.accountSummaryCurrent.findFirstOrThrow({
      where: { generationId, accountId },
    })
    expect(row.activeLabelKeys).toEqual([labelKey])
    expect(row.activeLabelCount).toBe(1)
  })

  it('AccountLabelLatest の全ラベルを AccountClassificationCurrent に書き出す', async () => {
    const accountId = await createAccount('carol')
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `bot_${randomUUID().slice(0, 8)}`, description: 'テスト用ラベル' },
    })
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: false,
      confidence: 0.4,
      reason: 'no match',
      labeledAt: new Date(),
    })

    const generationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, { generationId, sourceWatermarkAt: new Date() })

    const rows = await prisma.accountClassificationCurrent.findMany({
      where: { generationId, accountId },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe(false)
    expect(rows[0]?.reason).toBe('no match')
  })

  it('ラベル解除を AccountLabelChange に記録し lastClassificationChangedAt に反映する', async () => {
    const accountId = await createAccount('dave')
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `spam_${randomUUID().slice(0, 8)}`, description: 'テスト用ラベル' },
    })
    const labeledAt = new Date(Date.now() - 60 * 60 * 1000)
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: true,
      confidence: 0.9,
      reason: 'matched',
      labeledAt,
    })

    const firstGenerationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, {
      generationId: firstGenerationId,
      sourceWatermarkAt: labeledAt,
    })
    await prisma.readModelPointer.upsert({
      where: { modelKey: 'account_summary' },
      create: { modelKey: 'account_summary', currentGenerationId: firstGenerationId },
      update: { currentGenerationId: firstGenerationId },
    })

    const removedAt = new Date()
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: false,
      confidence: 0.9,
      reason: 'no longer matched',
      labeledAt: removedAt,
    })
    const secondGenerationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, {
      generationId: secondGenerationId,
      sourceWatermarkAt: removedAt,
    })

    const changes = await prisma.accountLabelChange.findMany({ where: { accountId } })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.changeType).toBe('removed')
    expect(changes[0]?.previousValue).toBe(true)
    expect(changes[0]?.newValue).toBe(false)

    const summary = await prisma.accountSummaryCurrent.findFirstOrThrow({
      where: { generationId: secondGenerationId, accountId },
    })
    expect(summary.activeLabelKeys).toEqual([])
    expect(summary.lastClassificationChangedAt?.getTime()).toBe(removedAt.getTime())
  })

  it('sourceWatermarkAt より後に付いたラベルは backlog 処理中の generation に混ぜない', async () => {
    const accountId = await createAccount('erin')
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `spam_${randomUUID().slice(0, 8)}`, description: 'テスト用ラベル' },
    })
    const watermarkAt = new Date(Date.now() - 60 * 60 * 1000)
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: false,
      confidence: 0.3,
      reason: 'no match',
      labeledAt: new Date(watermarkAt.getTime() - 60 * 60 * 1000),
    })
    // watermark より後に付いた値。backlog 処理中の古い generation には反映されないはず。
    await createAccountLabel({
      accountId,
      labelDefinitionId: labelDefinition.id,
      value: true,
      confidence: 0.9,
      reason: 'matched after watermark',
      labeledAt: new Date(watermarkAt.getTime() + 60 * 1000),
    })

    const generationId = `generation-${randomUUID()}`
    await buildAccountSummary(prisma, { generationId, sourceWatermarkAt: watermarkAt })

    const summary = await prisma.accountSummaryCurrent.findFirstOrThrow({
      where: { generationId, accountId },
    })
    expect(summary.activeLabelKeys).toEqual([])

    const classification = await prisma.accountClassificationCurrent.findFirstOrThrow({
      where: { generationId, accountId, labelDefinitionId: labelDefinition.id },
    })
    expect(classification.value).toBe(false)
    expect(classification.reason).toBe('no match')
  })
})
