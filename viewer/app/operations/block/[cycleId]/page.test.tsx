import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BlockOperationCycleDetailView } from '@/lib/queries/operation-cycles'

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/operation-cycles', () => ({ getBlockCycleDetail: vi.fn() }))
vi.mock('@/lib/queries/block-drilldown', () => ({ getBlockAccountRunsWithActions: vi.fn() }))

const { getBlockCycleDetail } = await import('@/lib/queries/operation-cycles')
const { getBlockAccountRunsWithActions } = await import('@/lib/queries/block-drilldown')
const { default: BlockCycleDetailPage } = await import('./page')

const baseDetail: BlockOperationCycleDetailView = {
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

describe('BlockCycleDetailPage', () => {
  it('account 単位テーブルに action 一覧 (label key・outbox status 解決済み) を表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    vi.mocked(getBlockCycleDetail).mockResolvedValue(baseDetail)
    vi.mocked(getBlockAccountRunsWithActions).mockResolvedValue([
      {
        id: 'bar-1',
        username: 'alice',
        candidatesCount: 2,
        blockedCount: 1,
        failedCount: 1,
        status: 'partial',
        errorMessage: null,
        actions: [
          {
            id: 'ba-1',
            blockedId: 'account-2',
            labelKey: 'test_label',
            confidence: 0.9,
            result: 'success',
            errorMessage: null,
            outboxStatus: 'local_persisted',
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

    expect(html).toContain('alice')
    expect(html).toContain('1 action(s)')
    expect(html).toContain('account-2')
    expect(html).toContain('test_label')
    expect(html).toContain('0.90')
    expect(html).toContain('Local persisted')
    expect(getBlockAccountRunsWithActions).toHaveBeenCalledWith(expect.anything(), 'block-run-1')
  })

  it('accountRuns が既定件数を超えると Show more リンクを表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    vi.mocked(getBlockCycleDetail).mockResolvedValue(baseDetail)
    vi.mocked(getBlockAccountRunsWithActions).mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        id: `bar-${index}`,
        username: `account_${index}`,
        candidatesCount: 0,
        blockedCount: 0,
        failedCount: 0,
        status: 'success',
        errorMessage: null,
        actions: [],
      })),
    )

    const html = renderToStaticMarkup(
      await BlockCycleDetailPage({
        params: Promise.resolve({ cycleId: 'cycle-1' }),
        searchParams: Promise.resolve({}),
      }),
    )

    expect(html).toContain('Show more')
    expect(html).toContain('account_19')
    expect(html).not.toContain('account_20')
  })

  it('outbox status ごとに異なる色クラスのバッジを表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    vi.mocked(getBlockCycleDetail).mockResolvedValue(baseDetail)
    vi.mocked(getBlockAccountRunsWithActions).mockResolvedValue([
      {
        id: 'bar-1',
        username: 'alice',
        candidatesCount: 2,
        blockedCount: 0,
        failedCount: 1,
        status: 'partial',
        errorMessage: null,
        actions: [
          {
            id: 'ba-1',
            blockedId: 'account-2',
            labelKey: 'test_label',
            confidence: 0.5,
            result: 'failure',
            errorMessage: 'remote error',
            outboxStatus: 'remote_failed',
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

    expect(html).toContain('Remote failed')
    expect(html).toContain('bg-red-100')
    expect(html).not.toContain('bg-green-100')
  })

  it('account 単位の errorMessage を Error 列に表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    vi.mocked(getBlockCycleDetail).mockResolvedValue(baseDetail)
    vi.mocked(getBlockAccountRunsWithActions).mockResolvedValue([
      {
        id: 'bar-1',
        username: 'alice',
        candidatesCount: 12,
        blockedCount: 10,
        failedCount: 2,
        status: 'partial',
        errorMessage: 'rate limited',
        actions: [],
      },
    ])

    const html = renderToStaticMarkup(
      await BlockCycleDetailPage({
        params: Promise.resolve({ cycleId: 'cycle-1' }),
        searchParams: Promise.resolve({}),
      }),
    )

    expect(html).toContain('rate limited')
  })
})
