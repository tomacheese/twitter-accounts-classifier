import { describe, expect, it, vi } from 'vitest'
import { createSyntheticId } from 'id-boundary'
import type { PrismaClient } from '../generated/prisma'
import { CRAWL_LIMITS } from '../config/crawl-limits'
import type { LabelRule } from '../labels/types'
import { getPrismaClient } from './client'
import {
  CARD_DESTINATION_URL_BACKFILL_LABEL_KEY,
  selectCardDestinationUrlBackfillCandidates,
} from './card-destination-url-backfill-repository'
import {
  ensureLabelDefinitionsForRules,
  recordAccountLabelsBulkForAccounts,
} from './label-repository'
import { getOrThrow } from './label-test-support'

describe('selectCardDestinationUrlBackfillCandidates query shape', () => {
  it('Account を起点に LATERAL fence 付きで AccountActiveLabel に ad_pr_hashtag の行があり Card 未評価の Tweet を持つ account を probe する', async () => {
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
    expect(candidateSql).toContain('FROM "AccountActiveLabel" AS active')
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

describe.skipIf(!process.env.DATABASE_URL)(
  'selectCardDestinationUrlBackfillCandidates (実 DB)',
  () => {
    it('ad_pr_hashtag が true で、直近の Tweet に Card 未評価を含む account だけを返す', async () => {
      const prisma = getPrismaClient()
      await prisma.$executeRawUnsafe(
        'TRUNCATE "AccountActiveLabel", "AccountLabelState", "AccountLabelChange", "LabelRuleVersion", "LabelDefinition", "Account" RESTART IDENTITY CASCADE',
      )
      const rule: LabelRule = {
        key: CARD_DESTINATION_URL_BACKFILL_LABEL_KEY,
        description: 'synthetic',
        version: '1.0.0',
        evaluate: () => ({ value: false, confidence: 1, reason: 'unused' }),
      }
      const ids = await ensureLabelDefinitionsForRules(prisma, [rule])
      const base = BigInt(createSyntheticId())
      const [labeledPending, labeledEvaluated, unlabeledPending] = [1n, 2n, 3n].map((offset) =>
        String(base + offset),
      )
      for (const [accountId, value, evaluated] of [
        [labeledPending, true, false],
        [labeledEvaluated, true, true],
        [unlabeledPending, false, false],
      ] as const) {
        await prisma.account.create({
          data: {
            id: accountId,
            screenName: `synthetic_${accountId}`,
            displayName: 'Synthetic account',
            followersCount: 0,
            followingCount: 0,
            tweetCount: 0,
            accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
          },
        })
        await prisma.tweet.create({
          data: {
            id: String(BigInt(accountId) + 1000n),
            accountId,
            fullText: 'synthetic tweet',
            createdAt: new Date(),
            retweetCount: 0,
            likeCount: 0,
            replyCount: 0,
            cardDestinationUrlsEvaluated: evaluated,
          },
        })
        await recordAccountLabelsBulkForAccounts(prisma, {
          labels: [
            {
              accountId,
              labelDefinitionId: getOrThrow(ids, CARD_DESTINATION_URL_BACKFILL_LABEL_KEY),
              result: { value, confidence: 0.9, reason: 'synthetic' },
              method: CARD_DESTINATION_URL_BACKFILL_LABEL_KEY,
              ruleVersion: '1.0.0',
            },
          ],
          expectedRevByAccountId: new Map([[accountId, 0]]),
          sourceKind: 'relabel',
        })
      }

      await expect(
        selectCardDestinationUrlBackfillCandidates(prisma, { limit: 10 }),
      ).resolves.toEqual({ accountIds: [labeledPending] })
    })
  },
)
