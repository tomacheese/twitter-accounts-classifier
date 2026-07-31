import { describe, expect, it } from 'vitest'
import { getPrismaClient } from './prisma'

describe('getPrismaClient', () => {
  it('returns the same instance on repeated calls', () => {
    expect(getPrismaClient()).toBe(getPrismaClient())
  })
})
