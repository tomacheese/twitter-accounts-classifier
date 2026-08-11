import { describe, expect, it, beforeEach } from 'vitest'
import { getPrismaClient } from './client'
import { recordAccountLabelsBulk, recordCrawlAccountLabelsAtomic } from './label-repository'

// node:crypto の randomUUID は label-repository.test.ts でモックされているが、
// このファイルは実 DB を使うため、そちらの影響を受けないよう別ファイルに分離する
// (モックされた固定 UUID のまま複数回 claim すると、CrawlAccountLabelRun.id の
// 主キー制約違反で意図しない例外になり、resume の冪等性テストが成立しない)。
describe.skipIf(!process.env.DATABASE_URL)('recordCrawlAccountLabelsAtomic', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
    await prisma.accountClassificationObservation.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.crawlAccountLabelRun.deleteMany()
    await prisma.crawlAuthorCheckpoint.deleteMany()
    await prisma.crawlRun.deleteMany()
    await prisma.labelDefinition.deleteMany()
    // 他の integration test ファイルが同じ DB に Block/Tweet を残していると、
    // account の外部キー制約により削除が失敗するため先に消しておく。
    await prisma.block.deleteMany()
    await prisma.tweet.deleteMany()
    await prisma.account.deleteMany()
  })

  it('creates one AccountClassificationObservation and enqueues account_summary_refresh in the same transaction when at least one claim succeeds', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_1',
        screenName: 'alice',
        displayName: 'Alice',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_label', description: 'テスト用ラベル' },
    })
    const crawlRun = await prisma.crawlRun.create({
      data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
    })

    const observationId = await recordCrawlAccountLabelsAtomic(prisma, {
      accountId: account.id,
      crawlRunId: crawlRun.id,
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: labelDefinition.id,
          result: { value: true, confidence: 0.9, reason: 'test reason' },
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    })

    expect(observationId).not.toBeNull()
    const observation = await prisma.accountClassificationObservation.findUnique({
      where: { id: observationId ?? '' },
    })
    expect(observation?.accountId).toBe(account.id)
    expect(observation?.labelCount).toBe(1)
    const latest = await prisma.accountLabelLatest.findUnique({
      where: {
        accountId_labelDefinitionId: {
          accountId: account.id,
          labelDefinitionId: labelDefinition.id,
        },
      },
    })
    expect(latest?.value).toBe(true)
    const workItem = await prisma.analysisWorkItem.findFirst({
      where: {
        kind: 'account_summary_refresh',
        triggerType: 'account_classification_observation',
        triggerId: observationId ?? '',
      },
    })
    expect(workItem).not.toBeNull()
  })

  it('returns null, creates no observation, and enqueues nothing when all rule claims were already recorded (resume)', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_2',
        screenName: 'bob',
        displayName: 'Bob',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_label_2', description: 'テスト用ラベル2' },
    })
    const crawlRun = await prisma.crawlRun.create({
      data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
    })
    const params = {
      accountId: account.id,
      crawlRunId: crawlRun.id,
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: labelDefinition.id,
          result: { value: false, confidence: 0.1, reason: 'test reason' },
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    }

    const first = await recordCrawlAccountLabelsAtomic(prisma, params)
    expect(first).not.toBeNull()

    const second = await recordCrawlAccountLabelsAtomic(prisma, params)
    expect(second).toBeNull()
    const workItemCount = await prisma.analysisWorkItem.count({
      where: { kind: 'account_summary_refresh' },
    })
    expect(workItemCount).toBe(1)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('recordAccountLabelsBulk', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
    await prisma.accountClassificationObservation.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.crawlAccountLabelRun.deleteMany()
    await prisma.crawlRun.deleteMany()
    await prisma.labelDefinition.deleteMany()
    await prisma.block.deleteMany()
    await prisma.account.deleteMany()
  })

  it('creates a new AccountLabel history row and advances labeledAt when only method changes', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_3',
        screenName: 'carol',
        displayName: 'Carol',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_label_3', description: 'テスト用ラベル3' },
    })
    const label = {
      labelDefinitionId: labelDefinition.id,
      result: { value: true, confidence: 0.9, reason: 'test reason' },
      ruleVersion: 'v1',
    }

    await recordAccountLabelsBulk(prisma, {
      accountId: account.id,
      sourceKind: 'crawl',
      sourceUsername: 'login_account',
      labels: [{ ...label, method: 'rule' }],
    })
    const firstLatest = await prisma.accountLabelLatest.findUniqueOrThrow({
      where: {
        accountId_labelDefinitionId: {
          accountId: account.id,
          labelDefinitionId: labelDefinition.id,
        },
      },
    })

    await recordAccountLabelsBulk(prisma, {
      accountId: account.id,
      sourceKind: 'crawl',
      sourceUsername: 'login_account',
      labels: [{ ...label, method: 'llm' }],
    })

    const historyCount = await prisma.accountLabel.count({
      where: { accountId: account.id, labelDefinitionId: labelDefinition.id },
    })
    expect(historyCount).toBe(2)
    const secondLatest = await prisma.accountLabelLatest.findUniqueOrThrow({
      where: {
        accountId_labelDefinitionId: {
          accountId: account.id,
          labelDefinitionId: labelDefinition.id,
        },
      },
    })
    expect(secondLatest.method).toBe('llm')
    expect(secondLatest.labeledAt.getTime()).toBeGreaterThan(firstLatest.labeledAt.getTime())
  })
})
