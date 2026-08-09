import { describe, it, expect, afterEach } from 'vitest'
import { getPrismaClient, getLeasePrismaClient, disconnectPrisma } from './client'

describe('getPrismaClient', () => {
  afterEach(async () => {
    await disconnectPrisma()
  })

  it('同一プロセス内では同一インスタンスを返す', () => {
    const first = getPrismaClient()
    const second = getPrismaClient()
    expect(first).toBe(second)
  })

  it('lease 更新用 client は処理用 client と別インスタンスを返す', () => {
    expect(getLeasePrismaClient()).not.toBe(getPrismaClient())
    expect(getLeasePrismaClient()).toBe(getLeasePrismaClient())
  })
})
