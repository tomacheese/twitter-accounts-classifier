import { describe, expect, it } from 'vitest'
import { formatDateTime, formatRelativeTime } from './format-date'

describe('formatDateTime', () => {
  it('formats a UTC instant as yyyy/MM/dd HH:mm:ss in JST', () => {
    expect(formatDateTime(new Date('2026-01-02T03:04:05Z'))).toBe('2026/01/02 12:04:05')
  })

  it('formats an ISO timestamp returned by a JSON API', () => {
    expect(formatDateTime('2026-01-02T03:04:05.000Z')).toBe('2026/01/02 12:04:05')
  })

  it('rolls the date over into the next day when JST crosses midnight', () => {
    expect(formatDateTime(new Date('2026-01-02T15:30:00Z'))).toBe('2026/01/03 00:30:00')
  })

  it('renders midnight as 00:00:00, not 24:00:00', () => {
    expect(formatDateTime(new Date('2026-01-02T15:00:00Z'))).toBe('2026/01/03 00:00:00')
  })

  it('zero-pads single-digit month, day, hour, minute, and second', () => {
    expect(formatDateTime(new Date('2026-03-04T00:05:06Z'))).toBe('2026/03/04 09:05:06')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-08-05T12:00:00Z')

  it('renders elapsed days and hours when at least a day has passed', () => {
    expect(formatRelativeTime(new Date('2026-08-02T04:00:00Z'), now)).toBe('3d 8h ago')
  })

  it('renders elapsed hours and minutes when under a day has passed', () => {
    expect(formatRelativeTime(new Date('2026-08-05T09:46:00Z'), now)).toBe('2h 14m ago')
  })

  it('renders elapsed minutes only when under an hour has passed', () => {
    expect(formatRelativeTime(new Date('2026-08-05T11:50:00Z'), now)).toBe('10m ago')
  })

  it('renders "just now" when under a minute has passed', () => {
    expect(formatRelativeTime(new Date('2026-08-05T11:59:30Z'), now)).toBe('just now')
  })

  it('clamps a future date to "just now" instead of a negative duration', () => {
    expect(formatRelativeTime(new Date('2026-08-05T12:05:00Z'), now)).toBe('just now')
  })
})
