import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { PLANNING_TRANSACTION_MAX_WAIT_MS, runPlanningTransaction } from './weekly-review-plan'

function makeFakePrisma(): { prisma: PrismaClient; transaction: ReturnType<typeof vi.fn> } {
  const tx = {} as unknown as PrismaClient
  const transaction = vi.fn((fn: (transactionClient: PrismaClient) => Promise<unknown>) => fn(tx))
  const prisma = { $transaction: transaction } as unknown as PrismaClient
  return { prisma, transaction }
}

describe('runPlanningTransaction', () => {
  it('RepeatableRead・maxWait・timeout を指定して $transaction を呼び出す', async () => {
    const { prisma, transaction } = makeFakePrisma()

    await runPlanningTransaction(prisma, () => Promise.resolve('planning-result'))

    expect(transaction).toHaveBeenCalledTimes(1)
    const options = transaction.mock.calls[0]?.[1] as Record<string, unknown>
    expect(options).toEqual({
      isolationLevel: 'RepeatableRead',
      timeout: 120_000,
      maxWait: PLANNING_TRANSACTION_MAX_WAIT_MS,
    })
  })
  it('fn へ渡される source を使って planning query の戻り値を返す', async () => {
    const { prisma } = makeFakePrisma()

    const result = await runPlanningTransaction(prisma, (source) => {
      expect(source).toBeDefined()
      return Promise.resolve('planning-result')
    })

    expect(result).toBe('planning-result')
  })
})
