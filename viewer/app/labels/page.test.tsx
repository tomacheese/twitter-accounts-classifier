import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { formatDateTime } from '@/lib/format-date'

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: vi.fn(() => ({})),
}))

vi.mock('@/lib/queries/dashboard', () => ({
  getLabelAggregateSnapshot: vi.fn(),
}))

vi.mock('@/lib/queries/label-summary', () => ({
  listLabelSummaries: vi.fn(),
}))

const { getLabelAggregateSnapshot } = await import('@/lib/queries/dashboard')
const { listLabelSummaries } = await import('@/lib/queries/label-summary')
const { default: LabelsPage } = await import('./page')

describe('LabelsPage', () => {
  it('shows the last successful aggregation time', async () => {
    const lastSuccessAt = new Date('2026-08-05T00:00:00Z')
    vi.mocked(getLabelAggregateSnapshot).mockResolvedValue({
      labeledAccounts: 42,
      distribution: [
        {
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          trueCount: 7,
          totalAccounts: 120,
        },
      ],
      lastSuccessAt,
      lastAttemptStatus: 'success',
    })

    const element = await LabelsPage()
    const html = renderToStaticMarkup(element)

    expect(html).toContain('spam')
    expect(html).toContain(formatDateTime(lastSuccessAt))
    expect(html).not.toContain('最新の集計に失敗しました')
  })

  it('shows true count/evaluated count/coverage/prevalence for the percentage in the legacy view', async () => {
    vi.mocked(getLabelAggregateSnapshot).mockResolvedValue({
      labeledAccounts: 42,
      distribution: [
        {
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          trueCount: 5,
          totalAccounts: 10_000,
        },
      ],
      lastSuccessAt: new Date('2026-08-05T00:00:00Z'),
      lastAttemptStatus: 'success',
    })

    const element = await LabelsPage()
    const html = renderToStaticMarkup(element)

    expect(html).toContain('5/10000 (&lt; 0.1%)')
  })

  it('shows a warning banner when the last aggregation attempt failed after a prior success', async () => {
    vi.mocked(getLabelAggregateSnapshot).mockResolvedValue({
      labeledAccounts: 42,
      distribution: [
        {
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          trueCount: 7,
          totalAccounts: 120,
        },
      ],
      lastSuccessAt: new Date('2026-08-05T00:00:00Z'),
      lastAttemptStatus: 'failed',
    })

    const element = await LabelsPage()
    const html = renderToStaticMarkup(element)

    expect(html).toContain('最新の集計に失敗しました。表示中の値は前回成功時点のものです')
  })

  it('shows a distinct warning banner when the aggregation has never succeeded', async () => {
    vi.mocked(getLabelAggregateSnapshot).mockResolvedValue({
      labeledAccounts: 0,
      distribution: [],
      lastSuccessAt: null,
      lastAttemptStatus: 'failed',
    })

    const element = await LabelsPage()
    const html = renderToStaticMarkup(element)

    expect(html).toContain(
      '最新の集計に失敗しました。まだ一度も集計が成功していないため、ラベル分布は表示できません。',
    )
    expect(html).not.toContain('表示中の値は前回成功時点のものです')
  })

  it('shows a placeholder dash for the last aggregation time when no aggregation has ever run', async () => {
    vi.mocked(getLabelAggregateSnapshot).mockResolvedValue({
      labeledAccounts: 0,
      distribution: [],
      lastSuccessAt: null,
      lastAttemptStatus: null,
    })

    const element = await LabelsPage()
    const html = renderToStaticMarkup(element)

    expect(html).toContain('No labels are registered yet.')
    expect(html).toContain('—')
  })

  it('shows true count/evaluated count/coverage/prevalence columns in the new view', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'labels'
    try {
      vi.mocked(listLabelSummaries).mockResolvedValue({
        readiness: 'ready',
        items: [
          {
            labelDefinitionId: 'label-1',
            labelKey: 'spam',
            evaluatedCount: 80,
            trueCount: 8,
            populationCount: 100,
            coverage: 0.8,
            prevalence: 0.1,
            qualityStatus: 'normal',
            activeFindingCount: 0,
            highestFindingSeverity: null,
          },
        ],
      })

      const html = renderToStaticMarkup(await LabelsPage())

      expect(html).toContain('True count')
      expect(html).toContain('Evaluated count')
      expect(html).toContain('Coverage')
      expect(html).toContain('>8<')
      expect(html).toContain('>80<')
      expect(html).toContain('80.0%')
      expect(html).toContain('10.0%')
      expect(html).not.toContain('low coverage')
    } finally {
      delete process.env.VIEWER_NEW_UI_SECTIONS
    }
  })

  it('shows a low coverage badge when qualityStatus is unknown in the new view', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'labels'
    try {
      vi.mocked(listLabelSummaries).mockResolvedValue({
        readiness: 'ready',
        items: [
          {
            labelDefinitionId: 'label-1',
            labelKey: 'spam',
            evaluatedCount: 0,
            trueCount: 0,
            populationCount: 0,
            coverage: 0,
            prevalence: 0,
            qualityStatus: 'unknown',
            activeFindingCount: 0,
            highestFindingSeverity: null,
          },
        ],
      })

      const html = renderToStaticMarkup(await LabelsPage())

      expect(html).toContain('low coverage')
    } finally {
      delete process.env.VIEWER_NEW_UI_SECTIONS
    }
  })
})
