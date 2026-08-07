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
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    labelAggregateStatus: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient & {
    $transaction: typeof transaction
    $executeRaw: ReturnType<typeof vi.fn>
    labelAggregate: {
      upsert: ReturnType<typeof vi.fn>
      deleteMany: ReturnType<typeof vi.fn>
    }
    labelAggregateStatus: { upsert: ReturnType<typeof vi.fn> }
  }
}

// spam/topic_tech と同系統の架空データ。値そのものに意味はなく、
// SQL を crawler 側へ移設しても算出結果の形が変わらないことの確認にのみ使う。
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
    const executeRawStrings = prisma.$executeRaw.mock.calls[0][0] as string[]
    expect(executeRawStrings.join('')).toContain("statement_timeout = '300000'")
  })

  it('returns zero values when the raw query returns no row', async () => {
    const prisma = createMockPrisma([[undefined, []]])

    const result = await computeLabelAggregateSnapshot(prisma)

    expect(result).toEqual({ labeledAccounts: 0, distribution: [] })
  })
})

describe('refreshLabelAggregate', () => {
  it('upserts LabelAggregate rows and a success status when the snapshot succeeds', async () => {
    const prisma = createMockPrisma([[undefined, [SAMPLE_ROW]], undefined])

    await refreshLabelAggregate(prisma)

    expect(prisma.labelAggregate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { labelDefinitionId: 'ld-spam' },
        update: expect.objectContaining({
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          trueCount: 7,
          totalCount: 120,
        }),
      }),
    )
    expect(prisma.labelAggregate.deleteMany).toHaveBeenCalledWith({
      where: { labelDefinitionId: { notIn: ['ld-spam'] } },
    })
    const statusCall = prisma.labelAggregateStatus.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>
    }
    expect(statusCall.update).toEqual(
      expect.objectContaining({ labeledAccounts: 42, lastAttemptStatus: 'success' }),
    )
  })

  it('falls back to deleting all rows when no label definitions remain', async () => {
    const emptyRow: MockSnapshotRow = { labeledAccounts: 0n, distribution: [] }
    const prisma = createMockPrisma([[undefined, [emptyRow]], undefined])

    await refreshLabelAggregate(prisma)

    expect(prisma.labelAggregate.upsert).not.toHaveBeenCalled()
    expect(prisma.labelAggregate.deleteMany).toHaveBeenCalledWith({})
  })

  it('does not touch LabelAggregate and upserts a failed status when the snapshot query throws', async () => {
    const prisma = createMockPrisma()
    prisma.$transaction.mockRejectedValueOnce(new Error('query_canceled'))

    await refreshLabelAggregate(prisma)

    expect(prisma.labelAggregate.upsert).not.toHaveBeenCalled()
    expect(prisma.labelAggregate.deleteMany).not.toHaveBeenCalled()
    const statusCall = prisma.labelAggregateStatus.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>
    }
    expect(statusCall.update).toEqual(
      expect.objectContaining({
        lastAttemptStatus: 'failed',
        lastErrorMessage: expect.stringContaining('Failed to refresh label aggregate'),
      }),
    )
  })

  it('upserts a failed status without touching prior success values when the write transaction throws', async () => {
    const prisma = createMockPrisma([[undefined, [SAMPLE_ROW]]])
    prisma.$transaction.mockRejectedValueOnce(new Error('unique_violation'))

    await refreshLabelAggregate(prisma)

    // モックの upsert は Prisma の遅延評価と異なりトランザクション配列の
    // 構築時点で即座に呼ばれるため、実際に確認したい失敗記録は最後の呼び出しになる。
    const statusCall = prisma.labelAggregateStatus.upsert.mock.calls.at(-1)?.[0] as {
      update: Record<string, unknown>
    }
    expect(statusCall.update).toEqual(
      expect.objectContaining({
        lastAttemptStatus: 'failed',
        lastErrorMessage: expect.stringContaining('Failed to refresh label aggregate'),
      }),
    )
  })
})
