import { createSyntheticId } from 'id-boundary'
import { afterEach, describe, expect, it } from 'vitest'
import { getPrismaClient } from './client'
import { loadBioCorpus } from './bio-corpus'

const prisma = getPrismaClient()
const accountIds: string[] = []

afterEach(async () => {
  await prisma.accountCrawlState.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
  accountIds.length = 0
})

async function createAccount(bio: string | null, lastCrawledAt: Date): Promise<string> {
  const id = createSyntheticId()
  accountIds.push(id)
  await prisma.account.create({
    data: {
      id,
      screenName: `synthetic_${id}`,
      displayName: 'Synthetic account',
      bio,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      crawlState: { create: { lastCrawledAt } },
    },
  })
  return id
}

describe.skipIf(!process.env.DATABASE_URL)('loadBioCorpus (integration)', () => {
  it('watermark 以前で bio を持つアカウントだけを、lastCrawledAt の新しい順に返す', async () => {
    const watermark = new Date('2026-03-01T00:00:00.000Z')
    const older = await createAccount('older bio', new Date('2026-01-01T00:00:00.000Z'))
    const newer = await createAccount('newer bio', new Date('2026-02-01T00:00:00.000Z'))
    await createAccount(null, new Date('2026-02-15T00:00:00.000Z'))
    await createAccount('after watermark', new Date('2026-04-01T00:00:00.000Z'))

    const corpus = await loadBioCorpus(prisma, watermark)
    const ours = corpus.filter((entry) => accountIds.includes(entry.accountId))

    expect(ours).toStrictEqual([
      { accountId: newer, bio: 'newer bio' },
      { accountId: older, bio: 'older bio' },
    ])
  })
})
