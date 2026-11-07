import { randomUUID } from 'node:crypto'
import { InvalidIdError, createSyntheticId } from 'id-boundary'
import { afterEach, describe, expect, it } from 'vitest'
import { getPrismaClient } from './client'

const prisma = getPrismaClient()
const accountIds: string[] = []
const clusterKeys: string[] = []

afterEach(async () => {
  await prisma.replyHijackEvidence.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.bioDuplicateClusterSize.deleteMany({ where: { clusterKey: { in: clusterKeys } } })
  accountIds.length = 0
  clusterKeys.length = 0
})

/**
 * 架空のアカウントを作成する。
 * @param id - 作成するアカウントの ID。省略時は架空の ID を採番する
 * @returns 作成したアカウントの ID (10 進文字列)
 */
async function createSyntheticAccount(id = createSyntheticId()): Promise<string> {
  accountIds.push(id)
  const created = await prisma.account.create({
    data: {
      id,
      screenName: `synthetic_${randomUUID()}`,
      displayName: 'Synthetic account',
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
    },
  })
  return created.id
}

describe.skipIf(!process.env.DATABASE_URL)('ID の境界変換 (integration)', () => {
  it('19 桁の ID を桁落ちなく保存し、文字列で読み戻す', async () => {
    const id = '9223372036854775806'
    const created = await createSyntheticAccount(id)

    expect(created).toBe(id)
    const found = await prisma.account.findUnique({ where: { id } })
    expect(found?.id).toBe(id)
    expect(typeof found?.id).toBe('string')
  })

  it('where の in / gt と orderBy は数値順で解釈される', async () => {
    const base = BigInt(createSyntheticId())
    const small = String(base + 9n)
    const large = String(base + 10n)
    await createSyntheticAccount(large)
    await createSyntheticAccount(small)

    const rows = await prisma.account.findMany({
      where: { id: { in: [small, large] } },
      orderBy: { id: 'asc' },
      select: { id: true },
    })
    expect(rows.map((row) => row.id)).toStrictEqual([small, large])

    const greater = await prisma.account.findMany({
      where: { id: { gt: small, in: [small, large] } },
      select: { id: true },
    })
    expect(greater.map((row) => row.id)).toStrictEqual([large])
  })

  it('bigint[] 列 (replyTweetIds) を文字列配列として往復する', async () => {
    const accountId = await createSyntheticAccount()
    const replyTweetIds = ['9223372036854775800', '9223372036854775801', '1']
    await prisma.replyHijackEvidence.create({
      data: {
        accountId,
        targetTweetId: createSyntheticId(),
        ruleVersion: 'synthetic-rule/1',
        swarmSize: 3,
        averageSimilarity: 0.9,
        spanHours: 1,
        replyTweetIds,
      },
    })

    const found = await prisma.replyHijackEvidence.findFirst({
      where: { accountId },
      include: { account: true },
    })
    expect(found?.replyTweetIds).toStrictEqual(replyTweetIds)
    expect(found?.accountId).toBe(accountId)
    expect(found?.account.id).toBe(accountId)
  })

  it('BioDuplicateClusterSize.memberIds を文字列配列として往復する', async () => {
    const clusterKey = `synthetic-${randomUUID()}`
    clusterKeys.push(clusterKey)
    const memberIds = [createSyntheticId(), createSyntheticId()]
    await prisma.bioDuplicateClusterSize.create({ data: { clusterKey, size: 2, memberIds } })

    const found = await prisma.bioDuplicateClusterSize.findUnique({ where: { clusterKey } })
    expect(found?.memberIds).toStrictEqual(memberIds)
  })

  it('数字以外の ID は DB へ送る前に InvalidIdError で拒否する', async () => {
    const rejection = prisma.account.findUnique({ where: { id: 'not-a-number' } })
    await expect(rejection).rejects.toBeInstanceOf(InvalidIdError)
    await expect(rejection).rejects.toThrow(
      'Invalid id string "not-a-number": must be a decimal integer without leading zeros',
    )
  })

  it('raw SQL は ::text で返し、::bigint で受ける', async () => {
    const id = await createSyntheticAccount()

    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS "id" FROM "Account" WHERE "id" = ANY(${[id]}::bigint[])
    `
    expect(rows).toStrictEqual([{ id }])
  })
})
