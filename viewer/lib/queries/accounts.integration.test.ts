import { createSyntheticId } from 'id-boundary'
import { afterAll, describe, expect, it } from 'vitest'
import { getPrismaClient } from '../prisma'
import { buildAccountOrderBy } from './accounts'

const prisma = getPrismaClient()
const baseId = BigInt(createSyntheticId())
const idOf = (offset: bigint): string => String(baseId + offset)

afterAll(async () => {
  const ids = [1n, 2n, 3n].map((offset) => idOf(offset))
  await prisma.accountCrawlState.deleteMany({ where: { accountId: { in: ids } } })
  await prisma.account.deleteMany({ where: { id: { in: ids } } })
})

describe.skipIf(!process.env.DATABASE_URL)('buildAccountOrderBy (integration)', () => {
  it('lastCrawledAt を AccountCrawlState 経由で並べ、同値は id 昇順にする', async () => {
    const crawledAt = [
      new Date('2026-01-03T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-03T00:00:00.000Z'),
    ]
    for (const [index, lastCrawledAt] of crawledAt.entries()) {
      await prisma.account.create({
        data: {
          id: idOf(BigInt(index + 1)),
          screenName: `synthetic_${index}_${baseId}`,
          displayName: 'Synthetic account',
          followersCount: index,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
          crawlState: { create: { lastCrawledAt } },
        },
      })
    }

    const ids = [1n, 2n, 3n].map((offset) => idOf(offset))
    const desc = await prisma.account.findMany({
      where: { id: { in: ids } },
      orderBy: buildAccountOrderBy('lastCrawledAt', 'desc'),
      select: { id: true },
    })
    expect(desc.map((row) => row.id)).toStrictEqual([ids[0], ids[2], ids[1]])

    const asc = await prisma.account.findMany({
      where: { id: { in: ids } },
      orderBy: buildAccountOrderBy('lastCrawledAt', 'asc'),
      select: { id: true },
    })
    expect(asc.map((row) => row.id)).toStrictEqual([ids[1], ids[0], ids[2]])

    const byFollowers = await prisma.account.findMany({
      where: { id: { in: ids } },
      orderBy: buildAccountOrderBy('followersCount', 'desc'),
      select: { id: true },
    })
    expect(byFollowers.map((row) => row.id)).toStrictEqual([ids[2], ids[1], ids[0]])
  })

  it('transaction ローカルの statement_timeout が $executeRaw の set_config で設定される', async () => {
    const timeout = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${'20000'}, true)`
      const rows = await tx.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`
      return rows[0].statement_timeout
    })
    expect(timeout).toBe('20s')
  })
})
