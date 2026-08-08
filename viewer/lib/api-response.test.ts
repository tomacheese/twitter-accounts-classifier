import { describe, it, expect } from 'vitest'
import { buildApiResponseMeta } from './api-response'

describe('buildApiResponseMeta', () => {
  it('必須項目を含むメタデータを組み立てる', () => {
    const generatedAt = new Date('2026-08-07T00:00:00.000Z')
    const sourceDataAt = new Date('2026-08-06T23:00:00.000Z')

    const meta = buildApiResponseMeta({
      generatedAt,
      sourceDataAt,
      generationId: 'generation-1',
      policyHash: 'policy-hash-1',
      freshnessStatus: 'healthy',
    })

    expect(meta).toEqual({
      generatedAt: generatedAt.toISOString(),
      sourceDataAt: sourceDataAt.toISOString(),
      generationId: 'generation-1',
      policyHash: 'policy-hash-1',
      freshnessStatus: 'healthy',
      nextCursor: null,
      isPartial: false,
    })
  })

  it('nextCursor と isPartial/reason を任意で指定できる', () => {
    const meta = buildApiResponseMeta({
      generatedAt: new Date('2026-08-07T00:00:00.000Z'),
      sourceDataAt: null,
      generationId: null,
      policyHash: null,
      freshnessStatus: 'stale',
      nextCursor: 'cursor-1',
      isPartial: true,
      partialReason: 'query timed out before all rows were scanned',
    })

    expect(meta.nextCursor).toBe('cursor-1')
    expect(meta.isPartial).toBe(true)
    expect(meta.partialReason).toBe('query timed out before all rows were scanned')
  })

  it('sourceDataAt が null の場合はメタデータでも null を保つ', () => {
    const meta = buildApiResponseMeta({
      generatedAt: new Date('2026-08-07T00:00:00.000Z'),
      sourceDataAt: null,
      generationId: null,
      policyHash: null,
      freshnessStatus: 'unknown',
    })

    expect(meta.sourceDataAt).toBeNull()
  })
})
