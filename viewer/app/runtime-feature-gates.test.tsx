import { describe, expect, it } from 'vitest'
import * as operationsPage from './operations/page'
import * as reviewPage from './review/page'

describe('runtime feature-gated pages', () => {
  it('renders review dynamically so runtime feature flags are honored', () => {
    expect(reviewPage.dynamic).toBe('force-dynamic')
  })

  it('renders operations dynamically so runtime feature flags are honored', () => {
    expect(operationsPage.dynamic).toBe('force-dynamic')
  })
})
