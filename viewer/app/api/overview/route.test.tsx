import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/prisma', () => ({
  getPrismaClient: vi.fn().mockReturnValue({
    readModelState: { findUnique: vi.fn().mockResolvedValue(null) },
    detectionPolicyVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    labelEvidenceEpoch: { findFirst: vi.fn().mockResolvedValue(null) },
    detectorState: { findUnique: vi.fn().mockResolvedValue(null) },
  }),
}))

const getOverviewSnapshot = vi.fn()
vi.mock('../../../lib/queries/overview', () => ({
  getOverviewSnapshot: (...args: unknown[]): unknown => getOverviewSnapshot(...args),
}))

describe('GET /api/overview', () => {
  const originalEnv = process.env.VIEWER_NEW_UI_SECTIONS

  beforeEach(() => {
    process.env.VIEWER_NEW_UI_SECTIONS = 'overview'
  })

  afterEach(() => {
    process.env.VIEWER_NEW_UI_SECTIONS = originalEnv
  })

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
      coreFreshnessStatus: 'delayed',
      corePerModel: [],
      coreFreshnessDivergesFromSnapshot: true,
    })

    const { GET } = await import('./route')
    const response = await GET()
    const body = (await response.json()) as {
      operationalStatus: string
      meta: { freshnessStatus: string }
      coreFreshnessStatus: string
      coreFreshnessDivergesFromSnapshot: boolean
    }

    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(body.operationalStatus).toBe('healthy')
    expect(body.meta.freshnessStatus).toBe('healthy')
    expect(body.coreFreshnessStatus).toBe('delayed')
    expect(body.coreFreshnessDivergesFromSnapshot).toBe(true)
  })

  it('OverviewSnapshot が無ければ unknown 状態のレスポンスを返す', async () => {
    getOverviewSnapshot.mockResolvedValue(null)

    const { GET } = await import('./route')
    const response = await GET()
    const body = (await response.json()) as { operationalStatus: string }

    expect(body.operationalStatus).toBe('unknown')
  })
})
