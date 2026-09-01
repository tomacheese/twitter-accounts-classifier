import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { PrismaWeeklyReviewPlanningDataSource } from './prisma-review-plan-data-source'

describe('PrismaWeeklyReviewPlanningDataSource', () => {
  it('change candidates は対象期間全体を WindowAgg せず新しい変更から絞り込む', async () => {
    const queries: { strings: readonly string[] }[] = []
    const prisma = {
      $queryRaw: vi.fn((query: { strings: readonly string[] }) => {
        queries.push(query)
        return Promise.resolve([])
      }),
    } as unknown as PrismaClient
    const source = new PrismaWeeklyReviewPlanningDataSource(prisma)

    await source.listChangeCandidates(
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-08-08T00:00:00Z'),
      80,
    )

    const sql = queries[0]?.strings.join('?') ?? ''
    expect(sql).toContain('NOT EXISTS')
    expect(sql).toContain('ORDER BY change."changedAt" DESC, change.id DESC')
    expect(sql).toContain('LIMIT ?')
    expect(sql.indexOf('JOIN "AccountLabelLatest"')).toBeLessThan(sql.indexOf('LIMIT ?'))
    expect(sql).not.toContain('row_number()')
  })

  it('population counts は WeeklyReviewSampleBucketCount を label×value 単位で合計する', async () => {
    const prisma = {
      weeklyReviewSampleBucketCount: {
        groupBy: vi.fn().mockResolvedValue([
          { labelDefinitionId: 'label-a', value: true, _sum: { count: 42 } },
          { labelDefinitionId: 'label-a', value: false, _sum: { count: 7 } },
        ]),
      },
    } as unknown as PrismaClient
    const source = new PrismaWeeklyReviewPlanningDataSource(prisma)

    const rows = await source.listPopulationCounts()

    expect(rows).toEqual([
      { labelDefinitionId: 'label-a', value: true, count: 42 },
      { labelDefinitionId: 'label-a', value: false, count: 7 },
    ])
  })

  it('baseline candidates は AccountLabel/AccountLabelLatest を一切クエリしない', async () => {
    const queries: { strings: readonly string[] }[] = []
    const prisma = {
      labelDefinition: {
        findMany: vi.fn().mockResolvedValue([{ id: 'label-a', key: 'alpha' }]),
      },
      weeklyReviewSampleBucketCount: {
        groupBy: vi.fn().mockResolvedValue([
          { labelDefinitionId: 'label-a', value: true, _sum: { count: 100 } },
          { labelDefinitionId: 'label-a', value: false, _sum: { count: 100 } },
        ]),
      },
      $queryRaw: vi.fn((query: { strings: readonly string[] }) => {
        queries.push(query)
        return Promise.resolve([])
      }),
    } as unknown as PrismaClient
    const source = new PrismaWeeklyReviewPlanningDataSource(prisma)

    await source.listBaselineCandidates(10, 'stable-seed')

    expect(queries).toHaveLength(2)
    for (const query of queries) {
      const sql = query.strings.join('?')
      expect(sql).not.toContain('AccountLabel')
      expect(sql).toContain('FROM "AccountClassificationLatest"')
      expect(sql).toContain('weekly_review_sample_bucket')
      expect(sql).toContain('evaluable')
      expect(sql).toContain('"labeledAt" IS NOT NULL')
    }
  })

  it('母集団件数が 0 の stratum は query しない', async () => {
    const queries: unknown[] = []
    const prisma = {
      labelDefinition: {
        findMany: vi.fn().mockResolvedValue([{ id: 'label-a', key: 'alpha' }]),
      },
      weeklyReviewSampleBucketCount: {
        groupBy: vi
          .fn()
          .mockResolvedValue([{ labelDefinitionId: 'label-a', value: true, _sum: { count: 100 } }]),
      },
      $queryRaw: vi.fn((query: unknown) => {
        queries.push(query)
        return Promise.resolve([])
      }),
    } as unknown as PrismaClient
    const source = new PrismaWeeklyReviewPlanningDataSource(prisma)

    await source.listBaselineCandidates(10, 'stable-seed')

    expect(queries).toHaveLength(1)
  })

  it('listChangeCandidates を除く全メソッドが AccountLabel/AccountLabelLatest を参照しない', () => {
    // tsconfig の module は CommonJS のため import.meta は使えない。
    // eslint-disable-next-line unicorn/prefer-module
    const sourcePath = path.join(__dirname, 'prisma-review-plan-data-source.ts')
    const source = readFileSync(sourcePath, 'utf8')
    const changeCandidatesStart = source.indexOf('public async listChangeCandidates')
    expect(changeCandidatesStart).toBeGreaterThan(0)

    const withoutChangeCandidates = source.slice(0, changeCandidatesStart)

    expect(withoutChangeCandidates).not.toContain('AccountLabel')
  })
})
