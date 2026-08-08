import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getLabelDetail } = vi.hoisted(() => ({ getLabelDetail: vi.fn() }))
const notFoundMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
)

vi.mock('next/navigation', () => ({ notFound: notFoundMock }))
vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/label-detail', () => ({ getLabelDetail }))

const { default: LabelDetailPage } = await import('./page')

function renderPage(labelKey: string) {
  return LabelDetailPage({
    params: Promise.resolve({ labelKey }),
    searchParams: Promise.resolve({}),
  })
}

const originalEnv = process.env.VIEWER_NEW_UI_SECTIONS

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  process.env.VIEWER_NEW_UI_SECTIONS = originalEnv
})

describe('LabelDetailPage', () => {
  it('labels 区画が無効なら notFound を呼び、getLabelDetail は問い合わせない', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = ''

    await expect(renderPage('spam')).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFoundMock).toHaveBeenCalled()
    expect(getLabelDetail).not.toHaveBeenCalled()
  })

  it('labels 区画が有効なら通常どおり描画する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'labels'
    getLabelDetail.mockResolvedValue({
      labelKey: 'spam',
      description: 'desc',
      latestSnapshot: null,
      latestAggregationFailed: false,
      trend: [],
      activeFindings: [],
    })

    await renderPage('spam')

    expect(notFoundMock).not.toHaveBeenCalled()
    expect(getLabelDetail).toHaveBeenCalled()
  })
})
