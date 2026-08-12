import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { buildOrUpdateCrawlCycle } from '../operations/build-crawl-cycle'
import {
  findPhantomCycleCrawlRunIds,
  runBackfill,
} from './backfill-remove-legacy-read-model-refresh-stage'

vi.mock('../operations/build-crawl-cycle', () => ({
  buildOrUpdateCrawlCycle: vi.fn().mockResolvedValue(undefined),
}))

/**
 * @param cycleFindManyResult - operationCycle.findMany が返す値 (呼び出し順に消費される)
 * @returns findPhantomCycleCrawlRunIds/runBackfill が参照するメソッドのみ差し替え可能なモック
 */
function createMockPrismaClient(cycleFindManyResult: { sourceId: string }[][]): {
  prisma: PrismaClient
  cycleFindMany: ReturnType<typeof vi.fn>
} {
  const cycleFindMany = vi.fn()
  for (const result of cycleFindManyResult) {
    cycleFindMany.mockResolvedValueOnce(result)
  }
  const workItemCount = vi.fn().mockResolvedValue(0)
  const prisma = {
    operationCycle: { findMany: cycleFindMany },
    analysisWorkItem: { count: workItemCount },
  } as unknown as PrismaClient
  return { prisma, cycleFindMany }
}

describe('findPhantomCycleCrawlRunIds', () => {
  it('phantom な read_model_refresh stage を持つ crawl cycle の sourceId を返す', async () => {
    const { prisma } = createMockPrismaClient([[{ sourceId: 'crawl-1' }, { sourceId: 'crawl-2' }]])

    const result = await findPhantomCycleCrawlRunIds(prisma)

    expect(result).toEqual(['crawl-1', 'crawl-2'])
  })
})

describe('runBackfill', () => {
  beforeEach(() => {
    vi.mocked(buildOrUpdateCrawlCycle).mockClear()
  })

  it('dry-run では buildOrUpdateCrawlCycle を呼ばない', async () => {
    const { prisma } = createMockPrismaClient([[{ sourceId: 'crawl-1' }]])

    const result = await runBackfill(prisma, false)

    expect(buildOrUpdateCrawlCycle).not.toHaveBeenCalled()
    expect(result).toEqual(['crawl-1'])
  })

  it('apply では対象ごとに buildOrUpdateCrawlCycle を呼び、補正後の残存件数を返す', async () => {
    const { prisma } = createMockPrismaClient([[{ sourceId: 'crawl-1' }], []])

    const result = await runBackfill(prisma, true)

    expect(buildOrUpdateCrawlCycle).toHaveBeenCalledWith(prisma, { crawlRunId: 'crawl-1' })
    expect(result).toEqual([])
  })

  it('apply しても phantom stage が残る場合はその ID を返す', async () => {
    const { prisma } = createMockPrismaClient([
      [{ sourceId: 'crawl-1' }],
      [{ sourceId: 'crawl-1' }],
    ])

    const result = await runBackfill(prisma, true)

    expect(result).toEqual(['crawl-1'])
  })
})
