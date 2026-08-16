import { randomUUID } from 'node:crypto'
import { describe, expect, it, beforeEach } from 'vitest'
import { getPrismaClient } from './client'

async function readCounter(prisma: ReturnType<typeof getPrismaClient>): Promise<number> {
  const row = await prisma.labeledAccountCounter.findUnique({ where: { id: 'global' } })
  return row?.labeledAccounts ?? 0
}

// AccountSummaryLatest への INSERT/UPDATE/DELETE で activeLabelCount が 0 ⇔ 正 を
// 跨いだ場合だけ LabeledAccountCounter が ±1 されることを、実際の Postgres トリガーに対して検証する。
describe.skipIf(!process.env.DATABASE_URL)(
  'account_summary_latest_labeled_counter_trigger (integration)',
  () => {
    const prisma = getPrismaClient()
    const accountId = `test_labeled_counter_${randomUUID().slice(0, 8)}`

    beforeEach(async () => {
      await prisma.accountSummaryLatest.deleteMany({ where: { accountId } })
    })

    it('INSERT で activeLabelCount が 0→正 のとき +1 される', async () => {
      const before = await readCounter(prisma)

      await prisma.accountSummaryLatest.create({
        data: {
          accountId,
          normalizedScreenName: 'test_user',
          normalizedDisplayName: 'test user',
          searchDocument: 'test_user test user',
          profileObservedAt: new Date('2026-08-01T00:00:00Z'),
          activeLabelKeys: ['spam'],
          activeLabelCount: 1,
        },
      })

      expect(await readCounter(prisma)).toBe(before + 1)
    })

    it('UPDATE で activeLabelCount が 0→正 のとき +1 される', async () => {
      await prisma.accountSummaryLatest.create({
        data: {
          accountId,
          normalizedScreenName: 'test_user',
          normalizedDisplayName: 'test user',
          searchDocument: 'test_user test user',
          profileObservedAt: new Date('2026-08-01T00:00:00Z'),
          activeLabelKeys: [],
          activeLabelCount: 0,
        },
      })
      const before = await readCounter(prisma)

      await prisma.accountSummaryLatest.update({
        where: { accountId },
        data: { activeLabelKeys: ['spam'], activeLabelCount: 1 },
      })

      expect(await readCounter(prisma)).toBe(before + 1)
    })

    it('UPDATE で activeLabelCount が 正→0 のとき -1 される', async () => {
      await prisma.accountSummaryLatest.create({
        data: {
          accountId,
          normalizedScreenName: 'test_user',
          normalizedDisplayName: 'test user',
          searchDocument: 'test_user test user',
          profileObservedAt: new Date('2026-08-01T00:00:00Z'),
          activeLabelKeys: ['spam'],
          activeLabelCount: 1,
        },
      })
      const before = await readCounter(prisma)

      await prisma.accountSummaryLatest.update({
        where: { accountId },
        data: { activeLabelKeys: [], activeLabelCount: 0 },
      })

      expect(await readCounter(prisma)).toBe(before - 1)
    })

    it('UPDATE で activeLabelCount が 正→正 のとき counter は不変', async () => {
      await prisma.accountSummaryLatest.create({
        data: {
          accountId,
          normalizedScreenName: 'test_user',
          normalizedDisplayName: 'test user',
          searchDocument: 'test_user test user',
          profileObservedAt: new Date('2026-08-01T00:00:00Z'),
          activeLabelKeys: ['spam'],
          activeLabelCount: 1,
        },
      })
      const before = await readCounter(prisma)

      await prisma.accountSummaryLatest.update({
        where: { accountId },
        data: { activeLabelKeys: ['spam', 'topic_tech'], activeLabelCount: 2 },
      })

      expect(await readCounter(prisma)).toBe(before)
    })

    it('DELETE で activeLabelCount が正の行のとき -1 される', async () => {
      await prisma.accountSummaryLatest.create({
        data: {
          accountId,
          normalizedScreenName: 'test_user',
          normalizedDisplayName: 'test user',
          searchDocument: 'test_user test user',
          profileObservedAt: new Date('2026-08-01T00:00:00Z'),
          activeLabelKeys: ['spam'],
          activeLabelCount: 1,
        },
      })
      const before = await readCounter(prisma)

      await prisma.accountSummaryLatest.delete({ where: { accountId } })

      expect(await readCounter(prisma)).toBe(before - 1)
    })

    it('カウンタは AccountSummaryLatest.activeLabelCount > 0 の件数と一致する (backfill整合性)', async () => {
      const [counter, actualCount] = await Promise.all([
        readCounter(prisma),
        prisma.accountSummaryLatest.count({ where: { activeLabelCount: { gt: 0 } } }),
      ])

      expect(counter).toBe(actualCount)
    })
  },
)
