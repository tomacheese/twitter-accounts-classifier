import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { formatDateTime } from '@/lib/format-date'

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/overview', () => ({ getOverviewSnapshot: vi.fn() }))
vi.mock('../page', () => ({ default: vi.fn() }))

const { getOverviewSnapshot } = await import('@/lib/queries/overview')
const { default: OverviewPage } = await import('./page')

describe('OverviewPage', () => {
  it('鮮度・データ時刻・pipeline status・stage・詳細リンクを表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'overview'
    const sourceDataAt = new Date('2026-08-08T16:14:05Z')
    vi.mocked(getOverviewSnapshot).mockResolvedValue({
      operationalStatus: 'attention',
      qualityStatus: 'watch',
      attention: [],
      latestPipeline: {
        cycleId: 'cycle-1',
        status: 'partial',
        stages: [
          { stageKey: 'crawl', status: 'partial' },
          { stageKey: 'read_model_refresh', status: 'succeeded' },
        ],
      },
      sourceDataAt,
      generationId: 'generation-1',
      policyHash: 'hash',
      freshnessStatus: 'delayed',
    })

    const html = renderToStaticMarkup(await OverviewPage())

    expect(html).toContain('Delayed')
    expect(html).toContain(formatDateTime(sourceDataAt))
    expect(html).toContain('Partial')
    expect(html).toContain('Read model refresh')
    expect(html).toContain('/operations/crawl/cycle-1')
  })
})
