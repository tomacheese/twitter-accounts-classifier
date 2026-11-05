import { describe, expect, it } from 'vitest'
import { getPrismaClient } from './prisma'
import { getAccountDetail } from './queries/account-detail'
import { listAccounts } from './queries/accounts'
import { getRelabelStatus } from './queries/relabel-status'

// scripts/db/e2e-smoke.sh が crawler、analyzer、viewer の順に同じ scratch DB へ流す smoke の 3 段目。
// 読み取り専用の viewer ロールで接続し、1 段目と 2 段目が作ったデータをアカウントページ向けのクエリで読む。
const enabled = process.env.DATABASE_URL !== undefined && process.env.E2E_SMOKE === '1'

const ALICE = '1900000000000000001'
const BOB = '1900000000000000002'
const CAROL = '1900000000000000003'

describe.skipIf(!enabled)('DB rebuild smoke: viewer queries', () => {
  const prisma = getPrismaClient()

  it('renders the account page data from the rebuilt schema', async () => {
    const detail = await getAccountDetail(prisma, ALICE, 3)
    expect(detail).not.toBeNull()
    expect(detail?.account.id).toBe(ALICE)
    expect(detail?.account.screenName).toBe('smoke_1')

    const blue = detail?.labels.find((label) => label.labelKey === 'verified_blue_individual')
    expect(blue?.status).toBe('true')
    expect(blue?.history.some((entry) => entry.changeType === 'added')).toBe(true)
    const bobDetail = await getAccountDetail(prisma, BOB, 3)
    expect(
      bobDetail?.labels.find((label) => label.labelKey === 'verified_blue_individual')?.status,
    ).toBe('false')

    // 直近ツイートは新しい順で、指定件数に切られる。
    expect(detail?.recentTweets.map((tweet) => tweet.id)).toEqual([
      '1910000000000000004',
      '1910000000000000003',
      '1910000000000000002',
    ])

    expect(await getAccountDetail(prisma, '1909999999999999999', 3)).toBeNull()

    const list = await listAccounts(prisma, {
      page: 1,
      pageSize: 50,
      sortBy: 'followersCount',
      sortDirection: 'desc',
    })
    expect(list.totalCount).toBe(3)
    expect(list.items.map((item) => item.id).toSorted()).toEqual([ALICE, BOB, CAROL])
    const filtered = await listAccounts(prisma, {
      labelKeys: ['verified_blue_individual'],
      page: 1,
      pageSize: 50,
      sortBy: 'followersCount',
      sortDirection: 'desc',
    })
    expect(filtered.items.map((item) => item.id)).toEqual([ALICE])

    const status = await getRelabelStatus(prisma)
    expect(status.labelCoverage.length).toBeGreaterThan(0)
  }, 60_000)
})
