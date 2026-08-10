import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BlockOperationCycleDetailView } from '@/lib/queries/operation-cycles'

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/operation-cycles', () => ({ getBlockCycleDetail: vi.fn() }))
vi.mock('@/lib/queries/block-drilldown', () => ({ getBlockAccountRunsWithActions: vi.fn() }))

const { getBlockCycleDetail } = await import('@/lib/queries/operation-cycles')
const { getBlockAccountRunsWithActions } = await import('@/lib/queries/block-drilldown')
const { default: BlockCycleDetailPage } = await import('./page')

const detail: BlockOperationCycleDetailView = {
  id: 'cycle-1',
  kind: 'block',
  status: 'succeeded',
  attentionRequired: false,
  triggeredAt: new Date('2026-08-08T00:00:00Z'),
  startedAt: new Date('2026-08-08T00:00:00Z'),
  finishedAt: new Date('2026-08-08T00:10:00Z'),
  sourceId: 'block-run-1',
  stages: [],
  accountRuns: [],
}

describe('BlockCycleDetailPage missing target', () => {
  it('shows skipped action and remote skipped outbox status', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    vi.mocked(getBlockCycleDetail).mockResolvedValue(detail)
    vi.mocked(getBlockAccountRunsWithActions).mockResolvedValue([
      {
        id: 'bar-1',
        username: 'alice',
        candidatesCount: 1,
        blockedCount: 0,
        failedCount: 0,
        status: 'completed',
        errorMessage: null,
        actions: [
          {
            id: 'ba-1',
            blockedId: 'account-missing',
            labelKey: 'test_label',
            confidence: 0.9,
            result: 'skipped',
            errorMessage: 'Block target user not found: account-missing',
            outboxStatus: 'remote_skipped',
          },
        ],
      },
    ])

    const html = renderToStaticMarkup(
      await BlockCycleDetailPage({
        params: Promise.resolve({ cycleId: 'cycle-1' }),
        searchParams: Promise.resolve({}),
      }),
    )

    expect(html).toContain('Skipped')
    expect(html).toContain('Remote skipped')
  })
})
