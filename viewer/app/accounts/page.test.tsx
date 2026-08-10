import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/queries/account-summary', () => ({
  listAccountSummaries: vi.fn(),
}))
vi.mock('@/lib/queries/accounts', () => ({
  listAccounts: vi.fn(() => Promise.reject(new Error('legacy path must not be used'))),
  getLabelKeys: vi.fn(() => Promise.reject(new Error('legacy path must not be used'))),
}))

const { listAccountSummaries } = await import('@/lib/queries/account-summary')
const { default: AccountsPage } = await import('./page')

describe('AccountsPage', () => {
  it('feature flag が無くても read model ベースの Accounts を表示する', async () => {
    process.env.VIEWER_NEW_UI_SECTIONS = ''
    vi.mocked(listAccountSummaries).mockResolvedValue({
      items: [
        {
          accountId: 'account-1',
          normalizedScreenName: 'alice',
          normalizedDisplayName: 'Alice',
          activeLabelKeys: ['spam'],
          activeLabelCount: 1,
          lastClassificationChangedAt: null,
          activeFindingCount: 0,
          highestFindingSeverity: null,
        },
      ],
      nextCursor: null,
      freshnessStatus: 'healthy',
      readiness: 'ready',
    })

    const html = renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain('@alice')
    expect(html).toContain('All accounts')
  })

  it('label 検索パラメータを listAccountSummaries の filters.labelKeys に渡す', async () => {
    vi.mocked(listAccountSummaries).mockResolvedValue({
      items: [],
      nextCursor: null,
      freshnessStatus: 'healthy',
      readiness: 'ready',
    })

    await AccountsPage({ searchParams: Promise.resolve({ label: 'bot' }) })

    expect(listAccountSummaries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filters: { labelKeys: ['bot'] } }),
    )
  })

  it('label 検索パラメータが複数指定された場合はすべて filters.labelKeys に渡す', async () => {
    vi.mocked(listAccountSummaries).mockResolvedValue({
      items: [],
      nextCursor: null,
      freshnessStatus: 'healthy',
      readiness: 'ready',
    })

    await AccountsPage({ searchParams: Promise.resolve({ label: ['bot', 'spam'] }) })

    expect(listAccountSummaries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filters: { labelKeys: ['bot', 'spam'] } }),
    )
  })

  it('label 検索パラメータが無ければ filters を渡さない', async () => {
    vi.mocked(listAccountSummaries).mockResolvedValue({
      items: [],
      nextCursor: null,
      freshnessStatus: 'healthy',
      readiness: 'ready',
    })

    await AccountsPage({ searchParams: Promise.resolve({}) })

    expect(listAccountSummaries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filters: undefined }),
    )
  })

  it('freshness を明示する', async () => {
    vi.mocked(listAccountSummaries).mockResolvedValue({
      items: [],
      nextCursor: null,
      freshnessStatus: 'delayed',
      readiness: 'ready',
    })

    const html = renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain('Delayed')
  })
})
