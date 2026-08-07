import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { listAccountSummaries } from './account-summary'

function createMockPrisma(overrides: { pointer?: unknown; rows?: unknown[] }) {
  const findUnique = vi.fn().mockResolvedValue(overrides.pointer ?? null)
  const findMany = vi.fn().mockResolvedValue(overrides.rows ?? [])
  const prisma = {
    readModelPointer: { findUnique },
    accountSummaryCurrent: { findMany },
  } as unknown as PrismaClient
  return { prisma, findUnique, findMany }
}

describe('listAccountSummaries', () => {
  it('ReadModelPointer が無ければ空配列を返す', async () => {
    const { prisma } = createMockPrisma({})
    const result = await listAccountSummaries(prisma, { view: 'all' })
    expect(result.items).toEqual([])
    expect(result.generationId).toBeNull()
  })

  it('view: recentlyChanged は lastClassificationChangedAt 降順で問い合わせる', async () => {
    const { prisma, findMany } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
    })

    await listAccountSummaries(prisma, { view: 'recentlyChanged' })

    const call = findMany.mock.calls[0][0] as { orderBy: unknown[] }
    expect(call.orderBy[0]).toEqual({ lastClassificationChangedAt: 'desc' })
  })

  it('常に current generationId で絞り込む (古い generation を返さない)', async () => {
    const { prisma, findMany } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-2' },
    })

    await listAccountSummaries(prisma, { view: 'all' })

    const call = findMany.mock.calls[0][0] as { where: { generationId: string } }
    expect(call.where.generationId).toBe('generation-2')
  })
})
