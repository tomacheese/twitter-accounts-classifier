import { describe, expect, it } from 'vitest'
import { formatDateTime } from './format-date'

describe('formatDateTime', () => {
  it('formats a UTC instant as yyyy/MM/dd HH:mm:ss in JST', () => {
    expect(formatDateTime(new Date('2026-01-02T03:04:05Z'))).toBe('2026/01/02 12:04:05')
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
