import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { listAccountSummaries } from './account-summary'
import { getPrismaClient } from '../prisma'

function createMockPrisma(overrides: {
  bootstrapStatus?: string
  accountSummaryLatestState?: unknown
  rows?: unknown[]
}) {
  const findMany = vi.fn().mockResolvedValue(overrides.rows ?? [])
  const prisma = {
    readModelBootstrap: {
      findUnique: vi.fn().mockResolvedValue({ status: overrides.bootstrapStatus ?? 'completed' }),
    },
    readModelState: {
      findUnique: vi
        .fn()
        .mockImplementation((args: { where: { modelKey: string } }) =>
          Promise.resolve(
            args.where.modelKey === 'account_summary_latest'
              ? (overrides.accountSummaryLatestState ?? null)
              : null,
          ),
        ),
    },
    readModelPointer: { findUnique: vi.fn().mockResolvedValue(null) },
    labelDefinition: { count: vi.fn().mockResolvedValue(0) },
    detectionPolicyVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    accountSummaryLatest: { findMany },
  } as unknown as PrismaClient
  return { prisma, findMany }
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
  it('bootstrap が完了していなければ空配列と readiness を返す', async () => {
    const { prisma } = createMockPrisma({ bootstrapStatus: 'running' })
    const result = await listAccountSummaries(prisma, { view: 'all' })
    expect(result.items).toEqual([])
    expect(result.readiness).toBe('bootstrapping')
    expect(result.generationId).toBeNull()
    expect(result.nextCursor).toBeNull()
  })

  it('view: recentlyChanged は lastClassificationChangedAt 降順で問い合わせる', async () => {
    const { prisma, findMany } = createMockPrisma({})

    await listAccountSummaries(prisma, { view: 'recentlyChanged' })

    const call = findMany.mock.calls[0][0] as { orderBy: unknown[] }
    expect(call.orderBy[0]).toEqual({ lastClassificationChangedAt: 'desc' })
  })

  it('freshnessStatus は ReadModelState の status を反映する', async () => {
    const { prisma } = createMockPrisma({
      accountSummaryLatestState: { status: 'stale' },
    })

    const result = await listAccountSummaries(prisma, { view: 'all' })

    expect(result.freshnessStatus).toBe('stale')
  })

  it('ReadModelState が未知の status なら freshnessStatus は unknown', async () => {
    const { prisma } = createMockPrisma({
      accountSummaryLatestState: { status: 'bogus' },
    })

    const result = await listAccountSummaries(prisma, { view: 'all' })

    expect(result.freshnessStatus).toBe('unknown')
  })

  it('limit を超える行があれば nextCursor を返し、返す件数は limit に収める', async () => {
    const { prisma } = createMockPrisma({
      rows: Array.from({ length: 3 }, (_, index) => createRow(index, null)),
    })

    const result = await listAccountSummaries(prisma, { view: 'all', limit: 2 })

    expect(result.items).toHaveLength(2)
    expect(result.nextCursor).not.toBeNull()
  })

  it('最終ページでは nextCursor を返さない', async () => {
    const { prisma } = createMockPrisma({
      rows: [createRow(0, null)],
    })

    const result = await listAccountSummaries(prisma, { view: 'all', limit: 2 })

    expect(result.nextCursor).toBeNull()
  })

  it('nextCursor を渡すと keyset 条件で続きから取得する', async () => {
    const first = createMockPrisma({
      rows: Array.from({ length: 3 }, (_, index) => createRow(index, null)),
    })
    const { nextCursor } = await listAccountSummaries(first.prisma, { view: 'all', limit: 2 })

    const second = createMockPrisma({})
    await listAccountSummaries(second.prisma, { view: 'all', limit: 2, cursor: nextCursor })

    const call = second.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } }
    expect(call.where.OR).toEqual([
      { normalizedScreenName: { gt: 'screen_1' } },
      { normalizedScreenName: 'screen_1', accountId: { gt: 'account-1' } },
    ])
  })

  it('filter が変わった cursor は無視する', async () => {
    const first = createMockPrisma({
      rows: Array.from({ length: 3 }, (_, index) => createRow(index, null)),
    })
    const { nextCursor } = await listAccountSummaries(first.prisma, { view: 'all', limit: 2 })

    const second = createMockPrisma({})
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
      rows: Array.from({ length: 2 }, (_, index) => createRow(index, null)),
    })
    const { nextCursor } = await listAccountSummaries(first.prisma, {
      view: 'recentlyChanged',
      limit: 1,
    })

    const second = createMockPrisma({})
    await listAccountSummaries(second.prisma, {
      view: 'recentlyChanged',
      limit: 1,
      cursor: nextCursor,
    })

    const call = second.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } }
    expect(call.where.OR).toEqual([
      { lastClassificationChangedAt: null, accountId: { lt: 'account-0' } },
      { lastClassificationChangedAt: { not: null } },
    ])
  })

  it('minFindingSeverity は閾値以上の severity だけに絞り込む', async () => {
    const { prisma, findMany } = createMockPrisma({})

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
    const { prisma, findMany } = createMockPrisma({})

    await listAccountSummaries(prisma, {
      view: 'all',
      filters: { minFindingSeverity: 'bogus' },
    })

    const call = findMany.mock.calls[0][0] as {
      where: { highestFindingSeverity?: unknown }
    }
    expect(call.where.highestFindingSeverity).toBeUndefined()
  })
})

describe.skipIf(!process.env.DATABASE_URL)('listAccountSummaries readiness', () => {
  const prisma = getPrismaClient()

  it('returns readiness bootstrapping instead of a silent empty array when bootstrap is running', async () => {
    await prisma.readModelBootstrap.deleteMany()
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'running' },
    })
    const result = await listAccountSummaries(prisma, { view: 'all' })
    expect(result.readiness).toBe('bootstrapping')
    expect(result.items).toEqual([])
  })
})
