import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { CRAWL_LIMITS } from '../config/crawl-limits'
import { selectCardDestinationUrlBackfillCandidates } from './card-destination-url-backfill-repository'

describe('selectCardDestinationUrlBackfillCandidates query shape', () => {
  it('Account を起点に LATERAL fence 付きで ad_pr_hashtag=true かつ Card 未評価の Tweet を probe する', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'ld-ad-pr-hashtag' }])
      .mockResolvedValueOnce([])
    const mockPrisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await selectCardDestinationUrlBackfillCandidates(mockPrisma, { limit: 2 })

    const definitionLookupSql = (queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join(
      '',
    )
    expect(definitionLookupSql).toContain('FROM "LabelDefinition"')
    expect(definitionLookupSql).toContain('"key" =')

    const candidateSql = (queryRaw.mock.calls[1][0] as { strings: string[] }).strings.join('')
    expect(candidateSql).toContain('FROM "Account" AS a')
    expect(candidateSql).toContain('CROSS JOIN LATERAL')
    expect(candidateSql).toContain('"labelDefinitionId" =')
    expect(candidateSql).toContain('"value" = true')
    expect(candidateSql).toContain('"cardDestinationUrlsEvaluated" = false')
    expect(candidateSql).toContain('ORDER BY t."createdAt" DESC')
    expect(candidateSql.match(/LIMIT/g)).toHaveLength(4)
  })

  it('候補判定を各 account の直近 recentTweetsPerAccount 件だけに絞り、それより古い未評価 Tweet だけでは候補化しない', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'ld-ad-pr-hashtag' }])
      .mockResolvedValueOnce([])
    const mockPrisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await selectCardDestinationUrlBackfillCandidates(mockPrisma, { limit: 2 })

    const candidateCall = queryRaw.mock.calls[1][0] as { strings: string[]; values: unknown[] }
    const candidateSql = candidateCall.strings.join('')
    const windowOrderIndex = candidateSql.indexOf('ORDER BY t."createdAt" DESC')
    const evaluatedFilterIndex = candidateSql.indexOf('"cardDestinationUrlsEvaluated" = false')
    // 未評価判定は「直近 N 件へ絞り込んでから」でなければならない。
    // 絞り込みより先に判定すると、21 件目以前の古い未評価 Tweet だけが残る account が
    // 新ラベルの評価窓 (直近 N 件) の外側にもかかわらず永久に候補化してしまう。
    expect(windowOrderIndex).toBeGreaterThan(-1)
    expect(windowOrderIndex).toBeLessThan(evaluatedFilterIndex)
    expect(candidateCall.values).toContain(CRAWL_LIMITS.recentTweetsPerAccount)
  })

  it('対象ラベルが1件も存在しない場合は Account への問い合わせを行わずに空ページを返す', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([])
    const mockPrisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await expect(
      selectCardDestinationUrlBackfillCandidates(mockPrisma, { limit: 2 }),
    ).resolves.toEqual({ accountIds: [] })
    expect(queryRaw).toHaveBeenCalledTimes(1)
  })

  it('cursor 付きページを指定件数で切り詰め、次ページがある場合のみ nextAfterId を返す', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'ld-ad-pr-hashtag' }])
      .mockResolvedValueOnce([{ accountId: 'a1' }, { accountId: 'a2' }, { accountId: 'a3' }])
    const mockPrisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await expect(
      selectCardDestinationUrlBackfillCandidates(mockPrisma, { limit: 2 }),
    ).resolves.toEqual({ accountIds: ['a1', 'a2'], nextAfterId: 'a2' })
  })
})
