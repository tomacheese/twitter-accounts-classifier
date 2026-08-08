import { describe, it, expect, afterEach } from 'vitest'
import { getPrismaClient, disconnectPrisma } from './client'

describe('getPrismaClient', () => {
  afterEach(async () => {
    await disconnectPrisma()
  })

  it('同一プロセス内では同一インスタンスを返す', () => {
    const first = getPrismaClient()
    const second = getPrismaClient()
    expect(first).toBe(second)
  })
})
