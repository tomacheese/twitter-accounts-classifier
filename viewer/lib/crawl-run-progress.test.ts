import { describe, expect, it } from 'vitest'
import { isCurrentAccountStale } from './crawl-run-progress'

describe('isCurrentAccountStale', () => {
  it('treats a recently started account as not stale', () => {
    const startedAt = new Date('2026-01-01T00:00:00Z')
    const now = new Date('2026-01-01T00:05:00Z')
    expect(isCurrentAccountStale(startedAt, now)).toBe(false)
  })

  it('treats an account still within the threshold as not stale', () => {
    const startedAt = new Date('2026-01-01T00:00:00Z')
    const now = new Date('2026-01-01T02:59:59Z')
    expect(isCurrentAccountStale(startedAt, now)).toBe(false)
  })

  it('treats an account past the threshold as stale', () => {
    const startedAt = new Date('2026-01-01T00:00:00Z')
    const now = new Date('2026-01-01T03:00:01Z')
    expect(isCurrentAccountStale(startedAt, now)).toBe(true)
  })
})
