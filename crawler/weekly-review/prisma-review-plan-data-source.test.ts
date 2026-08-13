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

  it('population counts は label ごとに query を分割し期間 window を先に materialize する', async () => {
    const queries: { strings: readonly string[]; values: readonly unknown[] }[] = []
    const prisma = {
      labelDefinition: {
        findMany: vi.fn().mockResolvedValue([{ id: 'label-a' }, { id: 'label-b' }]),
      },
      $queryRaw: vi.fn((query: { strings: readonly string[]; values: readonly unknown[] }) => {
        queries.push(query)
        return Promise.resolve([])
      }),
    } as unknown as PrismaClient
    const source = new PrismaWeeklyReviewPlanningDataSource(prisma)

    await source.listPopulationCounts(
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-08-08T00:00:00Z'),
    )

    expect(queries).toHaveLength(2)
    expect(queries.map((query) => query.values[0])).toEqual(['label-a', 'label-b'])
    for (const query of queries) {
      const sql = query.strings.join('?')
      expect(sql).toContain('WITH windowed AS MATERIALIZED')
      expect(sql).toContain('WHERE label."labelDefinitionId" = ?')
      expect(sql).toContain('ORDER BY label."labeledAt" DESC, label.id DESC')
      expect(sql).toContain('FROM windowed')
      expect(sql).toContain('DISTINCT ON (windowed."accountId")')
      expect(sql).toContain(
        'ORDER BY windowed."accountId", windowed."labeledAt" DESC, windowed.id DESC',
      )
      expect(sql).toContain('AND label.evaluable')
    }
  })
})
