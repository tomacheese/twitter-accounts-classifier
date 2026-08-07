import { describe, expect, it, vi } from 'vitest'

const connect = vi.fn().mockResolvedValue(undefined)

vi.mock('./db/client', () => ({
  getPrismaClient: () => ({ $connect: connect }),
  disconnectPrisma: vi.fn().mockResolvedValue(undefined),
}))

describe('main', () => {
  it('例外を投げずに $connect を呼ぶ', async () => {
    const { main } = await import('./index')

    await expect(main()).resolves.toBeUndefined()
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
