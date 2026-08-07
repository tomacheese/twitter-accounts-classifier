import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../../generated/prisma'
import { resolveOperationCycleRedirectTarget } from '@/lib/legacy-redirect'

function createMockPrisma(cycle: unknown) {
  return {
    operationCycle: { findUnique: vi.fn().mockResolvedValue(cycle) },
  } as unknown as PrismaClient
}

describe('resolveOperationCycleRedirectTarget (旧 /crawl-runs/[id] のリダイレクト先解決)', () => {
  it('対応する OperationCycle が存在すれば /operations/crawl/[cycleId] へのパスを返す', async () => {
    const prisma = createMockPrisma({ id: 'cycle-1' })

    const target = await resolveOperationCycleRedirectTarget(prisma, {
      sourceType: 'crawl_run',
      sourceId: 'run-1',
      detailPathPrefix: '/operations/crawl',
      fallbackHref: '/operations?kind=crawl',
    })

    expect(target).toBe('/operations/crawl/cycle-1')
    const findUnique = (
      prisma as unknown as { operationCycle: { findUnique: ReturnType<typeof vi.fn> } }
    ).operationCycle.findUnique
    expect(findUnique).toHaveBeenCalledWith({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: 'run-1' } },
    })
  })

  it('対応する OperationCycle が存在しなければ Operations 一覧の filter へのパスを返す', async () => {
    const prisma = createMockPrisma(null)

    const target = await resolveOperationCycleRedirectTarget(prisma, {
      sourceType: 'crawl_run',
      sourceId: 'run-missing',
      detailPathPrefix: '/operations/crawl',
      fallbackHref: '/operations?kind=crawl',
    })

    expect(target).toBe('/operations?kind=crawl')
  })
})
