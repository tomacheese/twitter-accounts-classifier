import { beforeEach, describe, expect, it } from 'vitest'
import { getPrismaClient } from '../db/client'
import {
  ORPHAN_CHECK_TABLES,
  reportOrphanIssue,
  runOrphanCheck,
  type OrphanCheckTable,
} from './orphan-check'

const FAST = { pauseMs: 0 }
const NOW = new Date('2026-08-08T00:00:00.000Z')

const prisma = getPrismaClient()

function check(): Promise<Awaited<ReturnType<typeof runOrphanCheck>>> {
  return runOrphanCheck(prisma, { ...FAST, tables: ['AccountLabelState'] })
}

async function createAccount(id: string): Promise<void> {
  await prisma.account.create({
    data: {
      id,
      accountCreatedAt: NOW,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      screenName: `user_${id}`,
      displayName: `User ${id}`,
    },
  })
}

describe.skipIf(!process.env.DATABASE_URL)('runOrphanCheck (実DB)', () => {
  /** 各表に、`accountId` を持つ行を 1 件ずつ作る。 */
  const seeders: Record<OrphanCheckTable, (accountId: string, index: number) => Promise<unknown>> =
    {
      Tweet: (accountId, index) =>
        prisma.tweet.create({
          data: {
            id: `${9000 + index}`,
            accountId,
            createdAt: NOW,
            retweetCount: 0,
            likeCount: 0,
            replyCount: 0,
            fullText: 'test',
          },
        }),
      AccountLabelState: (accountId) =>
        prisma.accountLabelState.create({ data: { accountId, evaluatedAt: NOW } }),
      AccountActiveLabel: (accountId) =>
        prisma.accountActiveLabel.create({
          data: {
            accountId,
            labeledAt: NOW,
            confidence: 1,
            labelDefinitionId: 1,
            ruleVersionNo: 1,
            method: 'rule',
            reason: 'test',
          },
        }),
      AccountLabelChange: (accountId) =>
        prisma.accountLabelChange.create({
          data: { accountId, changeType: 'added', labelDefinitionId: 1 },
        }),
      AccountClassificationLatest: (accountId) =>
        prisma.accountClassificationLatest.create({
          data: {
            accountId,
            observedAt: NOW,
            confidence: 1,
            labelDefinitionId: 1,
            value: true,
            reason: 'test',
            method: 'rule',
            ruleVersion: '1',
          },
        }),
      AccountClassificationObservation: (accountId) =>
        prisma.accountClassificationObservation.create({
          data: { accountId, observedAt: NOW, labelCount: 0 },
        }),
      AccountSummaryLatest: (accountId) =>
        prisma.accountSummaryLatest.create({
          data: {
            accountId,
            normalizedScreenName: 'test_user',
            normalizedDisplayName: 'test user',
            searchDocument: 'test_user test user',
            profileObservedAt: NOW,
            activeLabelKeys: [],
            activeLabelCount: 0,
          },
        }),
    }

  beforeEach(async () => {
    await prisma.operationalIssueOccurrence.deleteMany()
    await prisma.operationalIssue.deleteMany()
    await prisma.accountSummaryLatest.deleteMany()
    await prisma.accountClassificationObservation.deleteMany()
    await prisma.accountClassificationLatest.deleteMany()
    // AccountActiveLabel の削除は監査トリガーが AccountLabelChange へ行を足すため、先に消す。
    await prisma.accountActiveLabel.deleteMany()
    await prisma.accountLabelChange.deleteMany()
    await prisma.accountLabelState.deleteMany()
    await prisma.tweet.deleteMany()
    await prisma.account.deleteMany()
  })

  it('対象の全表が、実在するアカウントだけを参照しているとき孤児を報告しない', async () => {
    await createAccount('1001')
    for (const [index, table] of ORPHAN_CHECK_TABLES.entries()) {
      await seeders[table]('1001', index)
    }

    const results = await runOrphanCheck(prisma, FAST)

    expect(results.map((result) => result.table)).toEqual([...ORPHAN_CHECK_TABLES])
    for (const result of results) {
      expect(result).toMatchObject({
        orphanAccountCount: 0,
        orphanRowCount: 0,
        sampleAccountIds: [],
        nextCursor: null,
      })
      // AccountActiveLabel の監査トリガーが、AccountLabelChange にも 1 行を足す。
      expect(result.scannedRows).toBe(result.table === 'AccountLabelChange' ? 2 : 1)
    }
  })

  it.each(ORPHAN_CHECK_TABLES)('%s の孤児を検出し、他の表は孤児なしとする', async (table) => {
    await createAccount('1001')
    await seeders[table]('1001', 0)
    await seeders[table]('2002', 1)

    const results = await runOrphanCheck(prisma, FAST)

    const target = results.find((result) => result.table === table)
    expect(target).toMatchObject({
      scannedRows: 2,
      orphanAccountCount: 1,
      orphanRowCount: 1,
      sampleAccountIds: ['2002'],
      nextCursor: null,
    })
    const otherOrphanTables = results
      .filter((result) => result.table !== table && result.orphanAccountCount > 0)
      .map((result) => result.table)
    // AccountActiveLabel への書き込みは、監査トリガーが同じ accountId の AccountLabelChange を足す。
    expect(otherOrphanTables).toEqual(table === 'AccountActiveLabel' ? ['AccountLabelChange'] : [])
  })

  it('孤児のアカウントが複数の行を持つとき、アカウント数と行数を別に数える', async () => {
    await prisma.tweet.createMany({
      data: ['1', '2', '3'].map((id) => ({
        id,
        accountId: '3003',
        createdAt: NOW,
        retweetCount: 0,
        likeCount: 0,
        replyCount: 0,
        fullText: 'test',
      })),
    })

    const results = await runOrphanCheck(prisma, { ...FAST, tables: ['Tweet'] })

    expect(results[0]).toMatchObject({ orphanAccountCount: 1, orphanRowCount: 3, scannedRows: 3 })
  })

  it('バッチ境界をまたぐ孤児を、重複も取りこぼしもなく数える', async () => {
    for (const id of ['1001', '1003', '1005']) await createAccount(id)
    for (const [index, accountId] of ['1001', '1002', '1003', '1004', '1005', '1006'].entries()) {
      await seeders.AccountLabelState(accountId, index)
    }

    const results = await runOrphanCheck(prisma, {
      ...FAST,
      tables: ['AccountLabelState'],
      batchSize: 2,
    })

    expect(results[0]).toMatchObject({
      scannedRows: 6,
      orphanAccountCount: 3,
      sampleAccountIds: ['1002', '1004', '1006'],
      nextCursor: null,
    })
  })

  it('バッチ数の上限で打ち切り、返した位置から再開すると続きを検査する', async () => {
    for (const [index, accountId] of ['1001', '1002', '1003', '1004'].entries()) {
      await seeders.AccountLabelState(accountId, index)
    }
    const options = { ...FAST, tables: ['AccountLabelState'] as const, batchSize: 2 }

    const [first] = await runOrphanCheck(prisma, { ...options, maxBatchesPerTable: 1 })
    expect(first).toMatchObject({
      scannedRows: 2,
      orphanAccountCount: 2,
      sampleAccountIds: ['1001', '1002'],
      nextCursor: '1002',
    })

    const [second] = await runOrphanCheck(prisma, {
      ...options,
      resumeFrom: { AccountLabelState: first.nextCursor ?? '' },
    })
    expect(second).toMatchObject({
      scannedRows: 2,
      orphanAccountCount: 2,
      sampleAccountIds: ['1003', '1004'],
      nextCursor: null,
    })
  })

  it('孤児が無いとき何も書き込まない', async () => {
    await createAccount('1001')
    await seeders.AccountLabelState('1001', 0)

    await runOrphanCheck(prisma, FAST)

    expect(await prisma.accountLabelState.count()).toBe(1)
    expect(await prisma.accountLabelChange.count()).toBe(0)
  })

  describe('reportOrphanIssue', () => {
    it('孤児があれば active な OperationalIssue と測定値を記録し、同じ日の再実行で重複しない', async () => {
      await seeders.AccountLabelState('2002', 0)

      await reportOrphanIssue(prisma, await check(), NOW)
      await reportOrphanIssue(prisma, await check(), NOW)

      const issues = await prisma.operationalIssue.findMany({ include: { occurrences: true } })
      expect(issues).toHaveLength(1)
      expect(issues[0]).toMatchObject({ component: 'db', type: 'orphan_rows', status: 'active' })
      expect(issues[0].occurrences).toHaveLength(1)
      expect(issues[0].occurrences[0].measurements).toEqual({
        AccountLabelState: {
          orphanAccountCount: 1,
          orphanRowCount: 1,
          sampleAccountIds: ['2002'],
        },
      })
    })

    it('孤児が解消し最後まで検査できたとき、issue を resolved にする', async () => {
      await seeders.AccountLabelState('2002', 0)
      await reportOrphanIssue(prisma, await check(), NOW)
      await prisma.accountLabelState.deleteMany()

      await reportOrphanIssue(prisma, await check(), new Date(NOW.getTime() + 1000))

      const issue = await prisma.operationalIssue.findFirstOrThrow()
      expect(issue.status).toBe('resolved')
    })

    it('検査を打ち切ったときは、孤児が無くても issue を resolved にしない', async () => {
      await seeders.AccountLabelState('2002', 0)
      await reportOrphanIssue(prisma, await check(), NOW)
      await prisma.accountLabelState.deleteMany()

      const truncated = await runOrphanCheck(prisma, {
        ...FAST,
        tables: ['AccountLabelState'],
        maxBatchesPerTable: 0,
      })
      await reportOrphanIssue(prisma, truncated, new Date(NOW.getTime() + 1000))

      const issue = await prisma.operationalIssue.findFirstOrThrow()
      expect(issue.status).toBe('active')
    })

    it('孤児が無く issue も無いとき何も作らない', async () => {
      await reportOrphanIssue(prisma, await check(), NOW)

      expect(await prisma.operationalIssue.count()).toBe(0)
    })
  })
})
