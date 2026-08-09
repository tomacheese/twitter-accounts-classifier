import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { listAccountSummaries } from './account-summary'

function createMockPrisma(overrides: {
  pointer?: unknown
  state?: unknown
  generation?: unknown
  rows?: unknown[]
}) {
  const findUnique = vi.fn().mockResolvedValue(overrides.pointer ?? null)
  const stateFindUnique = vi.fn().mockResolvedValue(overrides.state ?? null)
  const generationFindUnique = vi.fn().mockResolvedValue(overrides.generation ?? null)
  const findMany = vi.fn().mockResolvedValue(overrides.rows ?? [])
  const prisma = {
    readModelPointer: { findUnique },
    readModelState: { findUnique: stateFindUnique },
    readModelGeneration: { findUnique: generationFindUnique },
    accountSummaryCurrent: { findMany },
  } as unknown as PrismaClient
  return { prisma, findUnique, findMany }
}

function createRow(index: number, changedAt: Date | null) {
  return {
    accountId: `account-${index}`,
    normalizedScreenName: `screen_${index}`,
    normalizedDisplayName: `Display ${index}`,
    activeLabelKeys: [],
    activeLabelCount: 0,
    lastClassificationChangedAt: changedAt,
    activeFindingCount: 0,
    highestFindingSeverity: null,
  }
}

describe('listAccountSummaries', () => {
  it('ReadModelPointer が無ければ空配列を返す', async () => {
    const { prisma } = createMockPrisma({})
    const result = await listAccountSummaries(prisma, { view: 'all' })
    expect(result.items).toEqual([])
    expect(result.generationId).toBeNull()
    expect(result.nextCursor).toBeNull()
  })

  it('view: recentlyChanged は lastClassificationChangedAt 降順・NULL LAST で問い合わせる', async () => {
    const { prisma, findMany } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
    })

    await listAccountSummaries(prisma, { view: 'recentlyChanged' })

    const call = findMany.mock.calls[0][0] as { orderBy: unknown[] }
    expect(call.orderBy[0]).toEqual({
      lastClassificationChangedAt: { sort: 'desc', nulls: 'last' },
    })
  })

  it('常に current generationId で絞り込む (古い generation を返さない)', async () => {
    const { prisma, findMany } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-2' },
    })

    await listAccountSummaries(prisma, { view: 'all' })

    const call = findMany.mock.calls[0][0] as { where: { generationId: string } }
    expect(call.where.generationId).toBe('generation-2')
  })

  it('freshnessStatus は ReadModelState の status を反映する', async () => {
    const { prisma } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      state: { status: 'stale' },
    })

    const result = await listAccountSummaries(prisma, { view: 'all' })

    expect(result.freshnessStatus).toBe('stale')
  })

  it('ReadModelState が未知の status なら freshnessStatus は unknown', async () => {
    const { prisma } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      state: { status: 'bogus' },
    })

    const result = await listAccountSummaries(prisma, { view: 'all' })

    expect(result.freshnessStatus).toBe('unknown')
  })

  it('limit を超える行があれば nextCursor を返し、返す件数は limit に収める', async () => {
    const { prisma } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      rows: Array.from({ length: 3 }, (_, index) => createRow(index, null)),
    })

    const result = await listAccountSummaries(prisma, { view: 'all', limit: 2 })

    expect(result.items).toHaveLength(2)
    expect(result.nextCursor).not.toBeNull()
  })

  it('最終ページでは nextCursor を返さない', async () => {
    const { prisma } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      rows: [createRow(0, null)],
    })

    const result = await listAccountSummaries(prisma, { view: 'all', limit: 2 })

    expect(result.nextCursor).toBeNull()
  })

  it('nextCursor を渡すと keyset 条件で続きから取得する', async () => {
    const first = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      rows: Array.from({ length: 3 }, (_, index) => createRow(index, null)),
    })
    const { nextCursor } = await listAccountSummaries(first.prisma, { view: 'all', limit: 2 })

    const second = createMockPrisma({ pointer: { currentGenerationId: 'generation-1' } })
    await listAccountSummaries(second.prisma, { view: 'all', limit: 2, cursor: nextCursor })

    const call = second.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } }
    expect(call.where.OR).toEqual([
      { normalizedScreenName: { gt: 'screen_1' } },
      { normalizedScreenName: 'screen_1', accountId: { gt: 'account-1' } },
    ])
  })

  it('filter が変わった cursor は無視する', async () => {
    const first = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      rows: Array.from({ length: 3 }, (_, index) => createRow(index, null)),
    })
    const { nextCursor } = await listAccountSummaries(first.prisma, { view: 'all', limit: 2 })

    const second = createMockPrisma({ pointer: { currentGenerationId: 'generation-1' } })
    await listAccountSummaries(second.prisma, {
      view: 'all',
      limit: 2,
      cursor: nextCursor,
      filters: { labelKeys: ['spam'] },
    })

    const call = second.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } }
    expect(call.where.OR).toBeUndefined()
  })

  it('recentlyChanged の cursor が null 日時なら null 行の続きから辿る', async () => {
    const first = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      rows: Array.from({ length: 2 }, (_, index) => createRow(index, null)),
    })
    const { nextCursor } = await listAccountSummaries(first.prisma, {
      view: 'recentlyChanged',
      limit: 1,
    })

    const second = createMockPrisma({ pointer: { currentGenerationId: 'generation-1' } })
    await listAccountSummaries(second.prisma, {
      view: 'recentlyChanged',
      limit: 1,
      cursor: nextCursor,
    })

    const call = second.findMany.mock.calls[0][0] as {
      where: { lastClassificationChangedAt?: null; accountId?: { lt: string }; OR?: unknown[] }
    }
    expect(call.where.OR).toBeUndefined()
    expect(call.where.lastClassificationChangedAt).toBeNull()
    expect(call.where.accountId).toEqual({ lt: 'account-0' })
  })

  it('recentlyChanged の日時あり cursor は日時行の続きの後に null 行も辿る', async () => {
    const changedAt = new Date('2026-08-09T00:00:00Z')
    const first = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      rows: [createRow(0, changedAt), createRow(1, null)],
    })
    const { nextCursor } = await listAccountSummaries(first.prisma, {
      view: 'recentlyChanged',
      limit: 1,
    })

    const second = createMockPrisma({ pointer: { currentGenerationId: 'generation-1' } })
    await listAccountSummaries(second.prisma, {
      view: 'recentlyChanged',
      limit: 1,
      cursor: nextCursor,
    })

    const call = second.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } }
    expect(call.where.OR).toEqual([
      { lastClassificationChangedAt: { lt: changedAt } },
      { lastClassificationChangedAt: changedAt, accountId: { lt: 'account-0' } },
      { lastClassificationChangedAt: null },
    ])
  })

  it('minFindingSeverity は閾値以上の severity だけに絞り込む', async () => {
    const { prisma, findMany } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
    })

    await listAccountSummaries(prisma, {
      view: 'all',
      filters: { minFindingSeverity: 'high' },
    })

    const call = findMany.mock.calls[0][0] as {
      where: { highestFindingSeverity?: { in: string[] } }
    }
    expect(call.where.highestFindingSeverity).toEqual({ in: ['high', 'critical'] })
  })

  it('未知の minFindingSeverity は severity 絞り込みを行わない', async () => {
    const { prisma, findMany } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
    })

    await listAccountSummaries(prisma, {
      view: 'all',
      filters: { minFindingSeverity: 'bogus' },
    })

    const call = findMany.mock.calls[0][0] as {
      where: { highestFindingSeverity?: unknown }
    }
    expect(call.where.highestFindingSeverity).toBeUndefined()
  })

  it('current generation の validationSummary が partial なら partial metadata を返す', async () => {
    const { prisma } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      state: { status: 'healthy' },
      generation: {
        validationSummary: {
          isPartial: true,
          partialReason: 'crawl completed partially; some accounts may contain older data',
        },
      },
    })

    const result = await listAccountSummaries(prisma, { view: 'all' })

    expect(result.isPartial).toBe(true)
    expect(result.partialReason).toBe(
      'crawl completed partially; some accounts may contain older data',
    )
  })

  it('validationSummary が壊れていれば partial 扱いにしない', async () => {
    const { prisma } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      state: { status: 'healthy' },
      generation: { validationSummary: { isPartial: 'yes', partialReason: 123 } },
    })

    const result = await listAccountSummaries(prisma, { view: 'all' })

    expect(result.isPartial).toBe(false)
    expect(result.partialReason).toBeUndefined()
  })
})
