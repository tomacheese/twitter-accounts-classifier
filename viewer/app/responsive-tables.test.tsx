import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('mobile overflow safeguards', () => {
  it('keeps tables inside the viewport on small screens', () => {
    const css = readFileSync(path.join(import.meta.dirname, 'globals.css'), 'utf8')
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toMatch(/main table[\s\S]*overflow-x: auto/)
  })

  it('allows long System values to wrap', () => {
    const source = readFileSync(path.join(import.meta.dirname, 'system/page.tsx'), 'utf8')
    expect(source).toContain('className="break-all text-sm text-gray-600 dark:text-gray-400"')
    expect(source).toContain('<li key={entry.key} className="break-all">')
  })
})
