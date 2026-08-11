import { describe, expect, it, beforeEach } from 'vitest'
import { getPrismaClient } from './client'
import { upsertAccountsBulk, type AccountProfileInput } from './account-repository'

function makeInput(id: string, overrides: Partial<AccountProfileInput> = {}): AccountProfileInput {
  return {
    id,
    screenName: `user_${id}`,
    displayName: `User ${id}`,
    bio: null,
    profileImageUrl: null,
    followersCount: 0,
    followingCount: 0,
    tweetCount: 0,
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

// Prisma のバージョンアップで raw query 失敗時の error.meta.code の形状が変わった場合に検出できるよう、
// モックではなく実際の Postgres に対して SQLSTATE 抽出の前提を固定する。
describe.skipIf(!process.env.DATABASE_URL)(
  'upsertAccountsBulk SQLSTATE extraction (integration)',
  () => {
    const prisma = getPrismaClient()

    beforeEach(async () => {
      // 他の integration test ファイルが同じ DB に Account 参照行を残していると、
      // account の外部キー制約により削除が失敗するため先に消しておく。
      await prisma.analysisWorkItem.deleteMany()
      await prisma.accountClassificationObservation.deleteMany()
      await prisma.accountLabel.deleteMany()
      await prisma.accountLabelLatest.deleteMany()
      await prisma.crawlAccountLabelRun.deleteMany()
      await prisma.block.deleteMany()
      await prisma.account.deleteMany()
    })

    it('bisects past a row-local NOT NULL violation and still upserts the valid row', async () => {
      const badInput = { ...makeInput('bad_1'), screenName: null } as unknown as AccountProfileInput

      const result = await upsertAccountsBulk(prisma, [makeInput('good_1'), badInput])

      expect(result).toEqual(new Set(['good_1']))
      const persisted = await prisma.account.findUnique({ where: { id: 'good_1' } })
      expect(persisted).not.toBeNull()
      const missing = await prisma.account.findUnique({ where: { id: 'bad_1' } })
      expect(missing).toBeNull()
    })
  },
)
