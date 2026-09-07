import { beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { getPrismaClient } from './client'
import {
  recordAccountLabelsBulkLatestOnlyForAccounts,
  recordCrawlAccountLabelsAtomic,
  recordCrawlAccountLabelsAtomicWithinTx,
} from './label-repository'

/** 非同期 transaction 間のテスト用 barrier。 */
function createDeferred() {
  let settle!: () => void
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: settle }
}

/** 指定した Latest row が別 transaction に lock されているか確認する。 */
async function waitForLatestRowToBeLocked(
  prisma: PrismaClient,
  accountId: string,
  labelDefinitionId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await prisma.$queryRaw`
        SELECT 1
        FROM "AccountLabelLatest"
        WHERE "accountId" = ${accountId} AND "labelDefinitionId" = ${labelDefinitionId}
        FOR UPDATE NOWAIT
      `
    } catch (error) {
      if (String(error).includes('55P03') || String(error).includes('could not obtain lock')) {
        return true
      }
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

/** 指定した application_name の transaction が Postgres の lock wait に入るまで待つ。 */
async function waitForSessionToWaitOnLock(
  prisma: PrismaClient,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await prisma.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE application_name = ${applicationName} AND wait_event_type = 'Lock'
      ) AS "waiting"
    `
    if (rows[0]?.waiting) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for Postgres lock wait: ${applicationName}`)
}

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
    // 他の integration test / benchmark が同じ DB に Block/Tweet/Follow を残していると、
    // account の外部キー制約により削除が失敗するため先に消しておく。
    await prisma.block.deleteMany()
    await prisma.tweet.deleteMany()
    await prisma.follow.deleteMany()
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

  it('stores a classificationSnapshot covering every evaluated label, including semantic no-ops carrying the existing AccountLabelLatest value', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_snapshot',
        screenName: 'dave',
        displayName: 'Dave',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelA = await prisma.labelDefinition.create({
      data: { key: 'test_label_snapshot_a', description: 'テスト用ラベルA' },
    })
    const labelB = await prisma.labelDefinition.create({
      data: { key: 'test_label_snapshot_b', description: 'テスト用ラベルB' },
    })
    const crawlRun1 = await prisma.crawlRun.create({
      data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
    })

    const firstObservationId = await recordCrawlAccountLabelsAtomic(prisma, {
      accountId: account.id,
      crawlRunId: crawlRun1.id,
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: labelA.id,
          result: { value: true, confidence: 0.9, reason: 'reason a' },
          method: 'rule',
          ruleVersion: 'v1',
        },
        {
          labelDefinitionId: labelB.id,
          result: { value: false, confidence: 0.1, reason: 'reason b' },
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    })
    const firstObservation = await prisma.accountClassificationObservation.findUniqueOrThrow({
      where: { id: firstObservationId ?? '' },
    })
    expect(firstObservation.snapshotVersion).toBe(1)
    const firstSnapshot = firstObservation.classificationSnapshot as unknown as {
      labelDefinitionId: string
      value: boolean
    }[]
    expect(firstSnapshot).toHaveLength(2)
    expect(firstSnapshot.find((entry) => entry.labelDefinitionId === labelA.id)?.value).toBe(true)
    expect(firstSnapshot.find((entry) => entry.labelDefinitionId === labelB.id)?.value).toBe(false)

    // 2 回目の crawl (別 crawlRunId) で labelA を同一の内容で再評価する。
    // CrawlAccountLabelRun の一意制約は crawlRunId を含むため claim は成立するが、
    // AccountLabelLatest への値そのものは変わらない semanticNoOp になる。
    const crawlRun2 = await prisma.crawlRun.create({
      data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
    })
    const secondObservationId = await recordCrawlAccountLabelsAtomic(prisma, {
      accountId: account.id,
      crawlRunId: crawlRun2.id,
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: labelA.id,
          result: { value: true, confidence: 0.9, reason: 'reason a' },
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    })
    const secondObservation = await prisma.accountClassificationObservation.findUniqueOrThrow({
      where: { id: secondObservationId ?? '' },
    })
    const secondSnapshot = secondObservation.classificationSnapshot as unknown as {
      labelDefinitionId: string
      value: boolean
      confidence: number
    }[]
    expect(secondSnapshot).toHaveLength(1)
    expect(secondSnapshot[0].labelDefinitionId).toBe(labelA.id)
    expect(secondSnapshot[0].value).toBe(true)
    expect(secondSnapshot[0].confidence).toBe(0.9)
  })

  it('AccountLabelLatest の labeledAt guard が古い評価を拒否した場合、snapshot には永続化済み Latest を保存する', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_snapshot_guard',
        screenName: 'frank',
        displayName: 'Frank',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_label_snapshot_guard', description: '競合guardテスト用ラベル' },
    })
    const crawlRun = await prisma.crawlRun.create({
      data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
    })
    const newerLabeledAt = new Date('2100-01-01T00:00:00.000Z')
    await prisma.accountLabelLatest.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.99,
        reason: 'newer committed value',
        method: 'rule',
        ruleVersion: 'v2',
        evaluable: true,
        labeledAt: newerLabeledAt,
        sourceKind: 'relabel',
      },
    })

    const observationId = await recordCrawlAccountLabelsAtomic(prisma, {
      accountId: account.id,
      crawlRunId: crawlRun.id,
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: labelDefinition.id,
          result: { value: false, confidence: 0.1, reason: 'stale crawl value' },
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    })

    const latest = await prisma.accountLabelLatest.findUniqueOrThrow({
      where: {
        accountId_labelDefinitionId: {
          accountId: account.id,
          labelDefinitionId: labelDefinition.id,
        },
      },
    })
    expect(latest.value).toBe(true)
    expect(latest.ruleVersion).toBe('v2')
    expect(latest.labeledAt).toEqual(newerLabeledAt)

    const observation = await prisma.accountClassificationObservation.findUniqueOrThrow({
      where: { id: observationId ?? '' },
    })
    const snapshot = observation.classificationSnapshot as unknown as {
      labelDefinitionId: string
      value: boolean
      confidence: number
      reason: string
      ruleVersion: string
      labeledAt: string
    }[]
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({
      labelDefinitionId: labelDefinition.id,
      value: true,
      confidence: 0.99,
      reason: 'newer committed value',
      ruleVersion: 'v2',
      labeledAt: newerLabeledAt.toISOString(),
    })
  })

  it('同一crawlRunIdの部分的な再開呼び出しでも、前回claim済みのラベルをAccountLabelLatestから補いsnapshotに含める', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_partial_resume',
        screenName: 'erin',
        displayName: 'Erin',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelA = await prisma.labelDefinition.create({
      data: { key: 'test_label_partial_a', description: 'テスト用ラベルA' },
    })
    const labelB = await prisma.labelDefinition.create({
      data: { key: 'test_label_partial_b', description: 'テスト用ラベルB' },
    })
    const crawlRun = await prisma.crawlRun.create({
      data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
    })

    // 1 回目は labelA のみ claim・記録する (labelB の評価前にプロセスが再起動した想定)。
    await recordCrawlAccountLabelsAtomic(prisma, {
      accountId: account.id,
      crawlRunId: crawlRun.id,
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: labelA.id,
          result: { value: true, confidence: 0.9, reason: 'reason a' },
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    })

    // 2 回目は同一 crawlRunId で labelA・labelB 両方を渡す (再開後の再評価想定)。
    // labelA は CrawlAccountLabelRun の一意制約により claim できず、labelB のみ claim される。
    const resumedObservationId = await recordCrawlAccountLabelsAtomic(prisma, {
      accountId: account.id,
      crawlRunId: crawlRun.id,
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: labelA.id,
          result: { value: true, confidence: 0.9, reason: 'reason a' },
          method: 'rule',
          ruleVersion: 'v1',
        },
        {
          labelDefinitionId: labelB.id,
          result: { value: true, confidence: 0.8, reason: 'reason b' },
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    })
    const resumedObservation = await prisma.accountClassificationObservation.findUniqueOrThrow({
      where: { id: resumedObservationId ?? '' },
    })
    const resumedSnapshot = resumedObservation.classificationSnapshot as unknown as {
      labelDefinitionId: string
      value: boolean
    }[]
    // labelB (今回 claim) だけでなく、labelA (前回 claim・AccountLabelLatest から補完) も含む。
    expect(resumedSnapshot).toHaveLength(2)
    expect(resumedSnapshot.find((entry) => entry.labelDefinitionId === labelA.id)?.value).toBe(true)
    expect(resumedSnapshot.find((entry) => entry.labelDefinitionId === labelB.id)?.value).toBe(true)
  })

  it('部分 resume の全 label snapshot lock と concurrent bulk writer が deadlock せず完了する', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_partial_resume_lock_order',
        screenName: 'grace',
        displayName: 'Grace',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinitions = await Promise.all([
      prisma.labelDefinition.create({
        data: { key: 'test_label_lock_order_a', description: 'lock order test label A' },
      }),
      prisma.labelDefinition.create({
        data: { key: 'test_label_lock_order_b', description: 'lock order test label B' },
      }),
    ])
    const [firstLabel, secondLabel] = labelDefinitions.toSorted((a, b) => a.id.localeCompare(b.id))
    const crawlRun = await prisma.crawlRun.create({
      data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
    })
    const labels = [firstLabel, secondLabel].map((label, index) => ({
      labelDefinitionId: label.id,
      result: { value: index === 0, confidence: 0.9, reason: `reason ${index}` },
      method: 'rule',
      ruleVersion: 'v1',
    }))

    await recordCrawlAccountLabelsAtomic(prisma, {
      accountId: account.id,
      crawlRunId: crawlRun.id,
      username: 'login_account',
      labels: [labels[0]],
    })
    await prisma.accountLabelLatest.create({
      data: {
        accountId: account.id,
        labelDefinitionId: secondLabel.id,
        value: true,
        confidence: 0.1,
        reason: 'seeded before partial resume',
        method: 'rule',
        ruleVersion: 'v0',
        evaluable: true,
        labeledAt: new Date(),
        sourceKind: 'relabel',
      },
    })

    const firstLatestLocked = createDeferred()
    const allowConcurrentWrite = createDeferred()
    const concurrentBulkWrite = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL deadlock_timeout = '100ms'")
      await tx.$queryRaw`
        SELECT 1
        FROM "AccountLabelLatest"
        WHERE "accountId" = ${account.id} AND "labelDefinitionId" = ${firstLabel.id}
        FOR UPDATE
      `
      firstLatestLocked.resolve()
      await allowConcurrentWrite.promise
      return recordAccountLabelsBulkLatestOnlyForAccounts(tx as unknown as PrismaClient, {
        sourceKind: 'relabel',
        labels: labels.map((label) => ({
          ...label,
          accountId: account.id,
          result: {
            ...label.result,
            value: !label.result.value,
            reason: `concurrent ${label.result.reason}`,
          },
        })),
      })
    })
    await firstLatestLocked.promise
    const applicationName = 'tac_partial_resume_snapshot_prelock'
    const partialResume = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL application_name = '${applicationName}'`)
      return recordCrawlAccountLabelsAtomicWithinTx(tx as unknown as PrismaClient, {
        accountId: account.id,
        crawlRunId: crawlRun.id,
        username: 'login_account',
        labels,
      })
    })
    try {
      await waitForSessionToWaitOnLock(prisma, applicationName)
      const secondLatestWasLocked = await waitForLatestRowToBeLocked(
        prisma,
        account.id,
        secondLabel.id,
      )
      expect(secondLatestWasLocked).toBe(false)
      allowConcurrentWrite.resolve()
      await expect(Promise.all([partialResume, concurrentBulkWrite])).resolves.toHaveLength(2)
    } finally {
      allowConcurrentWrite.resolve()
      await Promise.allSettled([partialResume, concurrentBulkWrite])
    }
  }, 15_000)
})
