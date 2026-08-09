import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('React', React)

const { getBlockCycleDetail } = vi.hoisted(() => ({ getBlockCycleDetail: vi.fn() }))

vi.mock('next/navigation', () => ({ notFound: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/operation-cycles', () => ({ getBlockCycleDetail }))

const { default: BlockCycleDetailPage } = await import('./page')

const originalEnv = process.env.VIEWER_NEW_UI_SECTIONS

afterEach(() => {
  process.env.VIEWER_NEW_UI_SECTIONS = originalEnv
  vi.clearAllMocks()
})

describe('BlockCycleDetailPage', () => {
  it('実行元アカウントごとの candidates・blocked・failed・error を表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    getBlockCycleDetail.mockResolvedValue({
      id: 'cycle-1',
      kind: 'block',
      status: 'succeeded',
      attentionRequired: false,
      triggeredAt: new Date('2026-08-08T16:01:05Z'),
      startedAt: new Date('2026-08-08T16:01:05Z'),
      finishedAt: new Date('2026-08-08T16:13:58Z'),
      stages: [],
      accountRuns: [
        {
          id: 'account-run-1',
          username: 'alice',
          status: 'completed',
          startedAt: new Date('2026-08-08T16:02:00Z'),
          finishedAt: new Date('2026-08-08T16:03:00Z'),
          candidatesCount: 12,
          blockedCount: 10,
          failedCount: 2,
          errorMessage: 'rate limited',
        },
      ],
    })

    const html = renderToStaticMarkup(
      await BlockCycleDetailPage({ params: Promise.resolve({ cycleId: 'cycle-1' }) }),
    )

    expect(html).toContain('Account breakdown')
    expect(html).toContain('@alice')
    expect(html).toContain('Candidates')
    expect(html).toContain('>12<')
    expect(html).toContain('Blocked')
    expect(html).toContain('>10<')
    expect(html).toContain('Failed')
    expect(html).toContain('>2<')
    expect(html).toContain('rate limited')
  })
})
