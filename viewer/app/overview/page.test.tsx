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
      coreFreshnessStatus: 'delayed',
      corePerModel: [
        { modelKey: 'account_summary_latest', freshnessStatus: 'delayed' },
        { modelKey: 'label_summary', freshnessStatus: 'healthy' },
        { modelKey: 'attention_items', freshnessStatus: 'healthy' },
      ],
      coreFreshnessDivergesFromSnapshot: false,
    })

    const html = renderToStaticMarkup(await OverviewPage())

    expect(html).toContain('Delayed')
    expect(html).toContain(formatDateTime(sourceDataAt))
    expect(html).toContain('Partial')
    expect(html).toContain('Read model refresh')
    expect(html).toContain('/operations/crawl/cycle-1')
    expect(html).toContain('account_summary_latest')
    expect(html).toContain('label_summary')
    expect(html).toContain('attention_items')
  })

  it('主要 read model の worst-of が snapshot 自体の freshness と異なれば注記を表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'overview'
    vi.mocked(getOverviewSnapshot).mockResolvedValue({
      operationalStatus: 'healthy',
      qualityStatus: 'stable',
      attention: [],
      latestPipeline: null,
      sourceDataAt: new Date('2026-08-08T16:14:05Z'),
      generationId: 'generation-1',
      policyHash: 'hash',
      freshnessStatus: 'healthy',
      coreFreshnessStatus: 'delayed',
      corePerModel: [{ modelKey: 'account_summary_latest', freshnessStatus: 'delayed' }],
      coreFreshnessDivergesFromSnapshot: true,
    })

    const html = renderToStaticMarkup(await OverviewPage())

    expect(html).toContain('Snapshot 自体は')
    expect(html).toContain('元データの freshness は')
  })

  it('主要 read model の worst-of が snapshot 自体の freshness と一致すれば注記を表示しない', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'overview'
    vi.mocked(getOverviewSnapshot).mockResolvedValue({
      operationalStatus: 'healthy',
      qualityStatus: 'stable',
      attention: [],
      latestPipeline: null,
      sourceDataAt: new Date('2026-08-08T16:14:05Z'),
      generationId: 'generation-1',
      policyHash: 'hash',
      freshnessStatus: 'healthy',
      coreFreshnessStatus: 'healthy',
      corePerModel: [{ modelKey: 'account_summary_latest', freshnessStatus: 'healthy' }],
      coreFreshnessDivergesFromSnapshot: false,
    })

    const html = renderToStaticMarkup(await OverviewPage())

    expect(html).not.toContain('Snapshot 自体は')
  })
})
