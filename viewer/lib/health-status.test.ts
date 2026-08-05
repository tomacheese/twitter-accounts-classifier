import { describe, expect, it } from 'vitest'
import { deriveHealthStatus } from './health-status'

describe('deriveHealthStatus', () => {
  it('returns not_run when there is no execution record', () => {
    expect(deriveHealthStatus(null, new Date('2026-08-05T00:00:00Z'))).toBe('not_run')
  })

  it('returns running when status is running and staleAfterAt has not passed', () => {
    const run = {
      status: 'running',
      staleAfterAt: new Date('2026-08-05T01:00:00Z'),
    }
    expect(deriveHealthStatus(run, new Date('2026-08-05T00:59:00Z'))).toBe('running')
  })

  it('returns stale when status is running and staleAfterAt has passed', () => {
    const run = {
      status: 'running',
      staleAfterAt: new Date('2026-08-05T01:00:00Z'),
    }
    expect(deriveHealthStatus(run, new Date('2026-08-05T01:00:01Z'))).toBe('stale')
  })

  it('returns running when status is running and staleAfterAt is null (pre-migration row)', () => {
    const run = { status: 'running', staleAfterAt: null }
    expect(deriveHealthStatus(run, new Date('2026-08-05T00:00:00Z'))).toBe('running')
  })

  it('returns healthy for a Crawler-style success status', () => {
    const run = { status: 'success', staleAfterAt: new Date('2026-08-04T00:00:00Z') }
    expect(deriveHealthStatus(run, new Date('2026-08-05T00:00:00Z'))).toBe('healthy')
  })

  it('returns healthy for a Blocker-style completed status', () => {
    const run = { status: 'completed', staleAfterAt: new Date('2026-08-04T00:00:00Z') }
    expect(deriveHealthStatus(run, new Date('2026-08-05T00:00:00Z'))).toBe('healthy')
  })

  it('returns degraded for a partial status', () => {
    const run = { status: 'partial', staleAfterAt: null }
    expect(deriveHealthStatus(run, new Date('2026-08-05T00:00:00Z'))).toBe('degraded')
  })

  it('returns failed for a failed status', () => {
    const run = { status: 'failed', staleAfterAt: null }
    expect(deriveHealthStatus(run, new Date('2026-08-05T00:00:00Z'))).toBe('failed')
  })

  it('returns failed for a weekly analysis timeout status', () => {
    const run = { status: 'timeout', staleAfterAt: null }
    expect(deriveHealthStatus(run, new Date('2026-08-05T00:00:00Z'))).toBe('failed')
  })

  it('does not treat a completed run past its stale staleAfterAt as stale', () => {
    const run = { status: 'success', staleAfterAt: new Date('2026-01-01T00:00:00Z') }
    expect(deriveHealthStatus(run, new Date('2026-08-05T00:00:00Z'))).toBe('healthy')
  })

  it('returns unknown for an unrecognized status value', () => {
    const run = { status: 'archived', staleAfterAt: null }
    expect(deriveHealthStatus(run, new Date('2026-08-05T00:00:00Z'))).toBe('unknown')
  })
})
