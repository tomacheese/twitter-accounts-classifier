import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { formatDateTime } from '@/lib/format-date'

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: vi.fn(() => ({})),
}))

vi.mock('@/lib/queries/dashboard', () => ({
  getLabelAggregateSnapshot: vi.fn(),
}))

const { getLabelAggregateSnapshot } = await import('@/lib/queries/dashboard')
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
})
