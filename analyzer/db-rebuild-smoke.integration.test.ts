import { afterAll, describe, expect, it } from 'vitest'
import { disconnectPrisma, getPrismaClient } from './db/client'
import { main } from './index'

// scripts/db/e2e-smoke.sh が crawler、analyzer、viewer の順に同じ scratch DB へ流す smoke の 2 段目。
// 1 段目 (crawler) が積んだ work item を、最小権限の analyzer ロールで接続した analyzer が処理しきる。
const enabled = process.env.DATABASE_URL !== undefined && process.env.E2E_SMOKE === '1'

const ALICE = '1900000000000000001'

describe.skipIf(!enabled)('DB rebuild smoke: analyzer refresh', () => {
  const prisma = getPrismaClient()

  afterAll(async () => {
    await disconnectPrisma()
  })

  it('drains the queue and refreshes the account read models', async () => {
    const before = await prisma.analysisWorkItem.count({ where: { status: 'queued' } })
    expect(before).toBeGreaterThanOrEqual(1)

    await main()

    // 失敗や dead letter が残っていないこと。
    const unsettled = await prisma.analysisWorkItem.findMany({
      where: { status: { in: ['queued', 'leased', 'failed', 'dead'] } },
      select: { kind: true, status: true, lastErrorSummary: true },
    })
    expect(unsettled).toEqual([])

    const summary = await prisma.accountSummaryLatest.findUniqueOrThrow({
      where: { accountId: ALICE },
    })
    expect(summary.normalizedScreenName).toBe('smoke_1')
    expect(summary.activeLabelKeys).toContain('verified_blue_individual')
    expect(summary.activeLabelCount).toBe(summary.activeLabelKeys.length)
  }, 120_000)
})
