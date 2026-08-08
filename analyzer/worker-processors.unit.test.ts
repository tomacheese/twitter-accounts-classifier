import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import {
  getCrawlReadModelPublication,
  enqueueReadModelBootstrapIfMissing,
} from './worker-processors'

describe('getCrawlReadModelPublication', () => {
  it('partial crawl は公開対象だが partial として扱う', () => {
    expect(getCrawlReadModelPublication('partial')).toEqual({
      shouldPublish: true,
      isPartial: true,
      partialReason: 'crawl completed partially; some accounts may contain older data',
    })
  })

  it('failed crawl は read model を公開しない', () => {
    expect(getCrawlReadModelPublication('failed')).toEqual({
      shouldPublish: false,
      isPartial: false,
    })
  })
})

describe('enqueueReadModelBootstrapIfMissing', () => {
  it('account_summary pointer が無ければ最新 terminal crawl の label_metrics を再キューする', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined)
    const prisma = {
      readModelPointer: { findUnique: vi.fn().mockResolvedValue(null) },
      crawlRun: {
        findFirst: vi.fn().mockResolvedValue({ id: 'crawl-1', status: 'partial' }),
      },
      analysisWorkItem: { upsert },
    } as unknown as PrismaClient

    await enqueueReadModelBootstrapIfMissing(prisma)

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind_triggerType_triggerId: {
            kind: 'label_metrics',
            triggerType: 'crawl_run',
            triggerId: 'crawl-1',
          },
        },
        update: expect.objectContaining({ status: 'queued', attemptCount: 0 }),
      }),
    )
  })

  it('account_summary pointer があれば何もしない', async () => {
    const findFirst = vi.fn()
    const upsert = vi.fn()
    const prisma = {
      readModelPointer: {
        findUnique: vi.fn().mockResolvedValue({ currentGenerationId: 'generation-1' }),
      },
      crawlRun: { findFirst },
      analysisWorkItem: { upsert },
    } as unknown as PrismaClient

    await enqueueReadModelBootstrapIfMissing(prisma)

    expect(findFirst).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })
})
