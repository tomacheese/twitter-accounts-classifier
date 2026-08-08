import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getBlockRelationDetail } = vi.hoisted(() => ({ getBlockRelationDetail: vi.fn() }))
const notFoundMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
)

vi.mock('next/navigation', () => ({ notFound: notFoundMock }))
vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/block-relations', () => ({ getBlockRelationDetail }))

const { default: BlockDetailPage } = await import('./page')

function renderPage(blockId: string) {
  return BlockDetailPage({ params: Promise.resolve({ blockId }) })
}

const originalEnv = process.env.VIEWER_NEW_UI_SECTIONS

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  process.env.VIEWER_NEW_UI_SECTIONS = originalEnv
})

describe('BlockDetailPage', () => {
  it('blocks 区画が無効なら notFound を呼び、getBlockRelationDetail は問い合わせない', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = ''

    await expect(renderPage('block-1')).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFoundMock).toHaveBeenCalled()
    expect(getBlockRelationDetail).not.toHaveBeenCalled()
  })

  it('blocks 区画が有効なら通常どおり描画する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'blocks'
    getBlockRelationDetail.mockResolvedValue({
      id: 'block-1',
      blocker: { id: 'a1', screenName: 'alice', displayName: 'Alice' },
      blocked: { id: 'a2', screenName: 'bob', displayName: 'Bob' },
      status: 'active',
      firstSeenAt: new Date('2026-08-01T00:00:00Z'),
      lastSeenAt: new Date('2026-08-01T00:00:00Z'),
      lastCheckedAt: new Date('2026-08-01T00:00:00Z'),
      consecutiveMissingCount: 0,
      missingSinceAt: null,
      resolvedAt: null,
      timeline: [],
      relatedFindings: [],
      sourceKind: 'legacy',
    })

    await renderPage('block-1')

    expect(notFoundMock).not.toHaveBeenCalled()
    expect(getBlockRelationDetail).toHaveBeenCalled()
  })
})
