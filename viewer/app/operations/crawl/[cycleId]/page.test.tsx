import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OperationCycleDetailView } from '@/lib/queries/operation-cycles'

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/operation-cycles', () => ({ getCrawlCycleDetail: vi.fn() }))
vi.mock('@/lib/queries/crawl-drilldown', () => ({ getCrawlAccountRuns: vi.fn() }))

const { getCrawlCycleDetail } = await import('@/lib/queries/operation-cycles')
const { getCrawlAccountRuns } = await import('@/lib/queries/crawl-drilldown')
const { default: CrawlCycleDetailPage } = await import('./page')

const baseDetail: OperationCycleDetailView = {
  id: 'cycle-1',
  kind: 'crawl',
  status: 'succeeded',
  attentionRequired: false,
  triggeredAt: new Date('2026-08-08T00:00:00Z'),
  startedAt: new Date('2026-08-08T00:00:00Z'),
  finishedAt: new Date('2026-08-08T00:10:00Z'),
  sourceId: 'crawl-run-1',
  stages: [],
}

describe('CrawlCycleDetailPage', () => {
  it('account 単位テーブルに warning 集計と phase 別 duration を表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    vi.mocked(getCrawlCycleDetail).mockResolvedValue(baseDetail)
    vi.mocked(getCrawlAccountRuns).mockResolvedValue([
      {
        id: 'run-1',
        username: 'alice',
        recommendedCount: 10,
        followingCount: 3,
        trendingCount: 0,
        replyCount: 2,
        profileCount: 1,
        labelsAppliedCount: 4,
        followingSynced: true,
        followersSynced: true,
        blocksSynced: false,
        warningCounts: { rate_limited: 2, timeout: 1 },
        phaseDurations: [{ phase: 'following', durationMs: 1200, retryWaitMs: 100 }],
        startedAt: new Date('2026-08-08T00:00:00Z'),
        finishedAt: new Date('2026-08-08T00:05:00Z'),
        status: 'success',
      },
    ])

    const html = renderToStaticMarkup(
      await CrawlCycleDetailPage({
        params: Promise.resolve({ cycleId: 'cycle-1' }),
        searchParams: Promise.resolve({}),
      }),
    )

    expect(html).toContain('alice')
    expect(html).toContain('3 warning(s)')
    expect(html).toContain('rate_limited')
    expect(html).toContain('timeout')
    expect(html).toContain('following: 0m 01s')
    expect(getCrawlAccountRuns).toHaveBeenCalledWith(expect.anything(), 'crawl-run-1')
  })

  it('accountRuns が既定件数を超えると Show more リンクを表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    vi.mocked(getCrawlCycleDetail).mockResolvedValue(baseDetail)
    vi.mocked(getCrawlAccountRuns).mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        id: `run-${index}`,
        username: `account_${index}`,
        recommendedCount: 0,
        followingCount: 0,
        trendingCount: 0,
        replyCount: 0,
        profileCount: 0,
        labelsAppliedCount: 0,
        followingSynced: false,
        followersSynced: false,
        blocksSynced: false,
        warningCounts: {},
        phaseDurations: [],
        startedAt: new Date('2026-08-08T00:00:00Z'),
        finishedAt: null,
        status: 'running',
      })),
    )

    const html = renderToStaticMarkup(
      await CrawlCycleDetailPage({
        params: Promise.resolve({ cycleId: 'cycle-1' }),
        searchParams: Promise.resolve({}),
      }),
    )

    expect(html).toContain('Show more')
    expect(html).toContain('account_19')
    expect(html).not.toContain('account_20')
  })
})
