import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { getReadModelMeta, listAccountSummaries } = vi.hoisted(() => ({
  getReadModelMeta: vi.fn(),
  listAccountSummaries: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ getPrismaClient: () => ({}) }))
vi.mock('@/lib/read-model-meta', () => ({ getReadModelMeta }))
vi.mock('@/lib/queries/account-summary', () => ({ listAccountSummaries }))

const { GET } = await import('./route')

const originalEnv = process.env.VIEWER_NEW_UI_SECTIONS

beforeEach(() => {
  vi.clearAllMocks()
  process.env.VIEWER_NEW_UI_SECTIONS = 'accounts'
  listAccountSummaries.mockResolvedValue({
    items: [],
    freshnessStatus: 'healthy',
    nextCursor: null,
    readiness: 'ready',
  })
  getReadModelMeta.mockResolvedValue({
    generatedAt: new Date('2026-08-13T00:00:00Z'),
    sourceDataAt: null,
    generationId: null,
    policyHash: null,
    freshnessStatus: 'healthy',
  })
})

afterEach(() => {
  process.env.VIEWER_NEW_UI_SECTIONS = originalEnv
})

describe('GET /api/accounts', () => {
  it('Accounts の実データと同じ account_summary_latest の meta を返す', async () => {
    const response = await GET(new NextRequest('http://localhost/api/accounts'))

    expect(response.status).toBe(200)
    expect(getReadModelMeta).toHaveBeenCalledWith(expect.anything(), 'account_summary_latest')
  })
})
