import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/prisma', () => ({ getPrismaClient: vi.fn().mockReturnValue({}) }))

const getOverviewSnapshot = vi.fn()
vi.mock('../../../lib/queries/overview', () => ({
  getOverviewSnapshot: (...args: unknown[]): unknown => getOverviewSnapshot(...args),
}))

describe('GET /api/overview', () => {
  it('OverviewSnapshot があれば内容と meta を含めて返す', async () => {
    getOverviewSnapshot.mockResolvedValue({
      operationalStatus: 'healthy',
      qualityStatus: 'stable',
      attention: [],
      latestPipeline: null,
      sourceDataAt: new Date('2026-08-07T00:00:00.000Z'),
      generationId: 'generation-1',
      policyHash: 'hash-1',
      freshnessStatus: 'healthy',
    })

    const { GET } = await import('./route')
    const response = await GET()
    const body = (await response.json()) as {
      operationalStatus: string
      meta: { freshnessStatus: string }
    }

    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(body.operationalStatus).toBe('healthy')
    expect(body.meta.freshnessStatus).toBe('healthy')
  })

  it('OverviewSnapshot が無ければ unknown 状態のレスポンスを返す', async () => {
    getOverviewSnapshot.mockResolvedValue(null)

    const { GET } = await import('./route')
    const response = await GET()
    const body = (await response.json()) as { operationalStatus: string }

    expect(body.operationalStatus).toBe('unknown')
  })
})
