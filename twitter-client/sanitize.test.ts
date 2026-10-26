import { describe, expect, it } from 'vitest'
import { stripNul } from './sanitize'

describe('stripNul', () => {
  it('NUL のみを除去し他の文字は変えない', () => {
    expect(stripNul('a\u0000b\u0000\u0000c')).toBe('abc')
    expect(stripNul('a\tb\u0001c 日本語')).toBe('a\tb\u0001c 日本語')
  })

  it('null と undefined をそのまま返す', () => {
    expect(stripNul(null)).toBeNull()
    const result = stripNul(undefined as string | undefined)
    expect(result).toBeUndefined()
  })
})
