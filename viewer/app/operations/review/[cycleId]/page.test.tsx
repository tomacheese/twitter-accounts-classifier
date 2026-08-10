import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WeeklyReviewOperationCycleDetailView } from '@/lib/queries/operation-cycles'

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/operation-cycles', () => ({ getWeeklyReviewCycleDetail: vi.fn() }))

const { getWeeklyReviewCycleDetail } = await import('@/lib/queries/operation-cycles')
const { default: WeeklyReviewCycleDetailPage } = await import('./page')

const baseDetail: WeeklyReviewOperationCycleDetailView = {
  id: 'cycle-1',
  kind: 'weekly_review',
  status: 'succeeded',
  attentionRequired: false,
  triggeredAt: new Date('2026-08-08T00:00:00Z'),
  startedAt: new Date('2026-08-08T00:00:00Z'),
  finishedAt: new Date('2026-08-08T00:10:00Z'),
  sourceId: 'weekly-run-1',
  stages: [],
  findings: null,
}

describe('WeeklyReviewCycleDetailPage', () => {
  it('改行を維持した findings を表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    vi.mocked(getWeeklyReviewCycleDetail).mockResolvedValue({
      ...baseDetail,
      findings: '1行目\n2行目',
    })

    const html = renderToStaticMarkup(
      await WeeklyReviewCycleDetailPage({ params: Promise.resolve({ cycleId: 'cycle-1' }) }),
    )

    expect(html).toContain('whitespace-pre-wrap')
    expect(html).toContain('1行目\n2行目')
  })

  it('findings が null の実行でも画面が壊れない', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    vi.mocked(getWeeklyReviewCycleDetail).mockResolvedValue(baseDetail)

    const html = renderToStaticMarkup(
      await WeeklyReviewCycleDetailPage({ params: Promise.resolve({ cycleId: 'cycle-1' }) }),
    )

    expect(html).toContain('No findings recorded.')
  })
})
