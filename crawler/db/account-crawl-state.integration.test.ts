import { createSyntheticId } from 'id-boundary'
import { afterEach, describe, expect, it } from 'vitest'
import { getPrismaClient } from './client'
import {
  recordRecentTweetsFetchFailure,
  recordRecentTweetsFetchSuccess,
  upsertAccount,
  upsertAccountsBulk,
  type AccountProfileInput,
} from './account-repository'

const prisma = getPrismaClient()
const accountIds: string[] = []

afterEach(async () => {
  await prisma.accountCrawlState.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
  accountIds.length = 0
})

function makeInput(overrides: Partial<AccountProfileInput> = {}): AccountProfileInput {
  const id = createSyntheticId()
  accountIds.push(id)
  return {
    id,
    screenName: `synthetic_${id}`,
    displayName: 'Synthetic account',
    bio: 'synthetic bio',
    profileImageUrl: null,
    followersCount: 1,
    followingCount: 2,
    tweetCount: 3,
    accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
    location: null,
    url: null,
    isBlueVerified: false,
    verifiedType: null,
    professionalType: null,
    parodyCommentaryFanLabel: null,
    ...overrides,
  }
}

/** 行のバージョンを表す xmin を返す。行が書き換えられると値が変わる。 */
async function profileRowVersion(id: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ xmin: string }[]>`
    SELECT xmin::text AS xmin FROM "Account" WHERE id = ${id}::bigint
  `
  return rows[0].xmin
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe.skipIf(!process.env.DATABASE_URL)(
  'Account と AccountCrawlState の分割 (integration)',
  () => {
    it('新規アカウントはプロフィール行と AccountCrawlState の両方を作る', async () => {
      const input = makeInput()

      const { account } = await upsertAccount(prisma, input)

      expect(account.id).toBe(input.id)
      expect(account.screenName).toBe(input.screenName)
      expect(account.crawlState?.accountId).toBe(input.id)
      expect(account.crawlState?.lastCrawledAt).toBeInstanceOf(Date)
      expect(account.crawlState?.lastRecentTweetsAttemptedAt).toBeNull()
      expect(account.crawlState?.recentTweetsFetchStatus).toBeNull()
    })

    it('プロフィールが同じ再 upsert は Account 行を書き換えず、lastCrawledAt だけ進める', async () => {
      const input = makeInput()
      const first = await upsertAccount(prisma, input)
      const versionBefore = await profileRowVersion(input.id)
      await sleep(20)

      const second = await upsertAccount(prisma, input)

      expect(await profileRowVersion(input.id)).toBe(versionBefore)
      expect(second.account.updatedAt).toStrictEqual(first.account.updatedAt)
      const firstCrawledAt = first.account.crawlState?.lastCrawledAt.getTime() ?? Number.NaN
      const secondCrawledAt = second.account.crawlState?.lastCrawledAt.getTime() ?? Number.NaN
      expect(secondCrawledAt).toBeGreaterThan(firstCrawledAt)
    })

    it('プロフィールの列が 1 つでも変われば Account 行を更新する (null への変化も含む)', async () => {
      const input = makeInput()
      await upsertAccount(prisma, input)
      const versionBefore = await profileRowVersion(input.id)

      const changedCount = await upsertAccount(prisma, { ...input, followersCount: 99 })
      expect(changedCount.account.followersCount).toBe(99)
      expect(await profileRowVersion(input.id)).not.toBe(versionBefore)

      const versionAfterCount = await profileRowVersion(input.id)
      const clearedBio = await upsertAccount(prisma, { ...input, followersCount: 99, bio: null })
      expect(clearedBio.account.bio).toBeNull()
      expect(await profileRowVersion(input.id)).not.toBe(versionAfterCount)
    })

    it('bulk upsert も同じ意味論で、プロフィール不変の行は書き換えない', async () => {
      const unchanged = makeInput()
      const changed = makeInput()
      await upsertAccountsBulk(prisma, [unchanged, changed])
      const unchangedVersion = await profileRowVersion(unchanged.id)
      const changedVersion = await profileRowVersion(changed.id)

      const result = await upsertAccountsBulk(prisma, [
        unchanged,
        { ...changed, displayName: 'Renamed synthetic account' },
      ])

      expect(result).toStrictEqual(new Set([unchanged.id, changed.id]))
      expect(await profileRowVersion(unchanged.id)).toBe(unchangedVersion)
      expect(await profileRowVersion(changed.id)).not.toBe(changedVersion)
    })

    it('recent tweets の成功・失敗の記録は AccountCrawlState だけを更新する', async () => {
      const input = makeInput()
      await upsertAccount(prisma, input)
      const versionBefore = await profileRowVersion(input.id)
      const fetchedAt = new Date('2026-01-02T03:04:05.000Z')
      const failedAt = new Date('2026-01-03T03:04:05.000Z')

      const success = await recordRecentTweetsFetchSuccess(prisma, input.id, fetchedAt)
      expect(success.recentTweetsFetchStatus).toBe('success')
      expect(success.lastRecentTweetsAttemptedAt).toStrictEqual(fetchedAt)
      expect(success.lastRecentTweetsFetchedAt).toStrictEqual(fetchedAt)

      const failure = await recordRecentTweetsFetchFailure(prisma, input.id, failedAt)
      expect(failure.recentTweetsFetchStatus).toBe('failed')
      expect(failure.lastRecentTweetsAttemptedAt).toStrictEqual(failedAt)
      expect(failure.lastRecentTweetsFetchedAt).toStrictEqual(fetchedAt)

      expect(await profileRowVersion(input.id)).toBe(versionBefore)
    })
  },
)
