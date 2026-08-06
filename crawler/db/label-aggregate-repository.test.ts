import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { computeLabelAggregateSnapshot, refreshLabelAggregate } from './label-aggregate-repository'

interface MockSnapshotRow {
  labeledAccounts: bigint
  distribution: {
    labelDefinitionId: string
    labelKey: string
    labelDescription: string
    trueCount: number
    totalCount: number
  }[]
}

function createMockPrisma(transactionResults: unknown[] = []) {
  const transaction = vi.fn()
  for (const result of transactionResults) {
    transaction.mockResolvedValueOnce(result)
  }
  return {
    $transaction: transaction,
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    labelAggregate: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    labelAggregateStatus: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient & {
    $transaction: typeof transaction
    $executeRaw: ReturnType<typeof vi.fn>
    labelAggregate: {
      deleteMany: ReturnType<typeof vi.fn>
      createMany: ReturnType<typeof vi.fn>
    }
    labelAggregateStatus: { upsert: ReturnType<typeof vi.fn> }
  }
}

// このフィクスチャは viewer/lib/queries/dashboard.test.ts の SAMPLE_ROW と
// 同じ値を用いている。SQL を crawler 側へ移設しても算出結果が変わっていないことを
// 示す回帰確認を兼ねるため、意図的に値を揃えている。
const SAMPLE_ROW: MockSnapshotRow = {
  labeledAccounts: 42n,
  distribution: [
    {
      labelDefinitionId: 'ld-spam',
      labelKey: 'spam',
      labelDescription: 'Likely spam account',
      trueCount: 7,
      totalCount: 120,
    },
  ],
}

describe('computeLabelAggregateSnapshot', () => {
  it('sets statement_timeout and maps the merged raw query result', async () => {
    const prisma = createMockPrisma([[undefined, [SAMPLE_ROW]]])

    const result = await computeLabelAggregateSnapshot(prisma)

    expect(result).toEqual({
      labeledAccounts: 42,
      distribution: [
        {
          labelDefinitionId: 'ld-spam',
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          trueCount: 7,
          totalCount: 120,
        },
      ],
    })
    const calls = (prisma.$transaction.mock.calls[0][0] as unknown[]).length
    expect(calls).toBe(2)
  })

  it('returns zero values when the raw query returns no row', async () => {
    const prisma = createMockPrisma([[undefined, []]])

    const result = await computeLabelAggregateSnapshot(prisma)

    expect(result).toEqual({ labeledAccounts: 0, distribution: [] })
  })
})

describe('refreshLabelAggregate', () => {
  it('replaces LabelAggregate rows and upserts a success status when the snapshot succeeds', async () => {
    const prisma = createMockPrisma([[undefined, [SAMPLE_ROW]], undefined])

    await refreshLabelAggregate(prisma)

    expect(prisma.labelAggregate.deleteMany).toHaveBeenCalledWith({})
    expect(prisma.labelAggregate.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          labelDefinitionId: 'ld-spam',
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          trueCount: 7,
          totalCount: 120,
        }),
      ],
    })
    const statusCall = prisma.labelAggregateStatus.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>
    }
    expect(statusCall.update).toEqual(
      expect.objectContaining({ labeledAccounts: 42, lastAttemptStatus: 'success' }),
    )
  })

  it('does not touch LabelAggregate and upserts a failed status when the snapshot query throws', async () => {
    const prisma = createMockPrisma()
    prisma.$transaction.mockRejectedValueOnce(new Error('query_canceled'))

    await refreshLabelAggregate(prisma)

    expect(prisma.labelAggregate.deleteMany).not.toHaveBeenCalled()
    expect(prisma.labelAggregate.createMany).not.toHaveBeenCalled()
    const statusCall = prisma.labelAggregateStatus.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>
    }
    expect(statusCall.update).toEqual(
      expect.objectContaining({ lastAttemptStatus: 'failed', lastErrorMessage: 'query_canceled' }),
    )
  })
})
