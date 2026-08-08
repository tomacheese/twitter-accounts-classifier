import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/operation-cycles', () => ({ listOperationCycles: vi.fn() }))

const { listOperationCycles } = await import('@/lib/queries/operation-cycles')
const { default: OperationsPage } = await import('./page')

describe('OperationsPage', () => {
  it('状態・current stage・開始終了・所要時間を人間向けに表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'operations'
    vi.mocked(listOperationCycles).mockResolvedValue({
      items: [
        {
          id: 'cycle-1',
          kind: 'block',
          status: 'succeeded',
          attentionRequired: false,
          triggeredAt: new Date('2026-08-08T16:01:05Z'),
          startedAt: new Date('2026-08-08T16:01:05Z'),
          finishedAt: new Date('2026-08-08T16:13:58Z'),
          currentStageKey: null,
        },
      ],
      nextCursor: null,
    })

    const html = renderToStaticMarkup(await OperationsPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain('Block')
    expect(html).toContain('Succeeded')
    expect(html).toContain('12m 53s')
    expect(html).toContain('Finished')
  })
})
