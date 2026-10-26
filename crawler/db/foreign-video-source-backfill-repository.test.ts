import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { CRAWL_LIMITS } from '../config/crawl-limits'
import { selectForeignVideoSourceBackfillCandidates } from './foreign-video-source-backfill-repository'

function makePrisma(rows: unknown[]) {
  const queryRaw = vi.fn().mockResolvedValueOnce(rows)
  return { queryRaw, prisma: { $queryRaw: queryRaw } as unknown as PrismaClient }
}

describe('selectForeignVideoSourceBackfillCandidates', () => {
  it('直近 N 件へ絞り込んでから NULL を判定し、LATERAL fence 付きで probe する', async () => {
    const { queryRaw, prisma } = makePrisma([])

    await selectForeignVideoSourceBackfillCandidates(prisma, { limit: 2 })

    const call = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] }
    const sql = call.strings.join('')
    expect(sql).toContain('FROM "Account" AS a')
    expect(sql).toContain('CROSS JOIN LATERAL')
    expect(sql).toContain('"foreignVideoSourceCount" IS NULL')
    expect(sql).toContain('ORDER BY a."id" ASC')
    expect(sql.indexOf('ORDER BY t."createdAt" DESC')).toBeLessThan(
      sql.indexOf('"foreignVideoSourceCount" IS NULL'),
    )
    expect(call.values).toContain(CRAWL_LIMITS.recentTweetsPerAccount)
  })

  it('cursor を strict な id 比較として渡す', async () => {
    const { queryRaw, prisma } = makePrisma([])

    await selectForeignVideoSourceBackfillCandidates(prisma, { limit: 2, afterId: 'a1' })

    const call = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] }
    expect(call.strings.join('')).toContain('AND a."id" >')
    expect(call.values).toContain('a1')
  })

  it('指定件数で切り詰め、次ページがある場合のみ nextAfterId を返す', async () => {
    const { prisma } = makePrisma([{ accountId: 'a1' }, { accountId: 'a2' }, { accountId: 'a3' }])
    await expect(selectForeignVideoSourceBackfillCandidates(prisma, { limit: 2 })).resolves.toEqual(
      { accountIds: ['a1', 'a2'], nextAfterId: 'a2' },
    )

    const last = makePrisma([{ accountId: 'a1' }, { accountId: 'a2' }])
    await expect(
      selectForeignVideoSourceBackfillCandidates(last.prisma, { limit: 2 }),
    ).resolves.toEqual({ accountIds: ['a1', 'a2'] })
  })
})
