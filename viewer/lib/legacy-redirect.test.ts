import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { resolveOperationCycleRedirectTarget } from './legacy-redirect'

function createMockPrisma(cycle: unknown) {
  const findUnique = vi.fn().mockResolvedValue(cycle)
  const prisma = { operationCycle: { findUnique } } as unknown as PrismaClient
  return { prisma, findUnique }
}

const baseInput = {
  sourceType: 'crawl_run',
  sourceId: 'run-1',
  detailPathPrefix: '/operations/crawl',
  fallbackHref: '/operations?kind=crawl',
}

describe('resolveOperationCycleRedirectTarget', () => {
  it('対応する Cycle があればその詳細ページの URL を返す', async () => {
    const { prisma } = createMockPrisma({ id: 'cycle-1' })

    expect(await resolveOperationCycleRedirectTarget(prisma, baseInput)).toBe(
      '/operations/crawl/cycle-1',
    )
  })

  it('対応する Cycle が無ければフォールバック先の URL を返す', async () => {
    const { prisma } = createMockPrisma(null)

    expect(await resolveOperationCycleRedirectTarget(prisma, baseInput)).toBe(
      '/operations?kind=crawl',
    )
  })

  it('sourceType と sourceId の複合キーで逆引きする', async () => {
    const { prisma, findUnique } = createMockPrisma({ id: 'cycle-1' })

    await resolveOperationCycleRedirectTarget(prisma, baseInput)

    expect(findUnique).toHaveBeenCalledWith({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: 'run-1' } },
    })
  })
})
