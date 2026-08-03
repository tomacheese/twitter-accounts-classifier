import { describe, expect, it } from 'vitest'
import { formatDuration } from './format-duration'

describe('formatDuration', () => {
  it('formats seconds-only durations under a minute', () => {
    const startedAt = new Date('2026-01-01T00:00:00Z')
    const finishedAt = new Date('2026-01-01T00:00:45Z')
    expect(formatDuration(startedAt, finishedAt)).toBe('0m 45s')
  })

  it('formats minute-and-second durations under an hour', () => {
    const startedAt = new Date('2026-01-01T00:00:00Z')
    const finishedAt = new Date('2026-01-01T00:05:09Z')
    expect(formatDuration(startedAt, finishedAt)).toBe('5m 09s')
  })

  it('formats hour-minute-second durations at an hour or more', () => {
    const startedAt = new Date('2026-01-01T00:00:00Z')
    const finishedAt = new Date('2026-01-01T01:02:03Z')
    expect(formatDuration(startedAt, finishedAt)).toBe('1h 02m 03s')
  })

  it('clamps a negative duration to zero', () => {
    const startedAt = new Date('2026-01-01T00:00:10Z')
    const finishedAt = new Date('2026-01-01T00:00:00Z')
    expect(formatDuration(startedAt, finishedAt)).toBe('0m 00s')
  })
})
