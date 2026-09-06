import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import {
  checkRelabelStorageCircuitBreaker,
  resetRelabelStorageCircuitBreakerStateForTest,
} from './relabel-storage-circuit-breaker'

const ENV_KEYS = [
  'RELABEL_STORAGE_WARNING_AVAILABLE_GIB',
  'RELABEL_STORAGE_WARNING_USED_PERCENT',
  'RELABEL_STORAGE_BLOCKED_AVAILABLE_GIB',
  'RELABEL_STORAGE_BLOCKED_USED_PERCENT',
  'RELABEL_STORAGE_HYSTERESIS_RESUME_AVAILABLE_GIB',
  'RELABEL_STORAGE_HYSTERESIS_RESUME_USED_PERCENT',
  'RELABEL_STORAGE_MAX_STALE_SECONDS',
] as const

const NOW = new Date('2026-09-06T00:00:00.000Z')

function createMockPrisma(
  state: { availableGib: number; usedPercent: number; measuredAt: Date } | null,
) {
  return {
    storageCapacityState: {
      findUnique: () => Promise.resolve(state),
    },
  } as unknown as PrismaClient
}

describe('checkRelabelStorageCircuitBreaker', () => {
  const originalValues: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalValues[key] = process.env[key]
      Reflect.deleteProperty(process.env, key)
    }
    resetRelabelStorageCircuitBreakerStateForTest()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalValues[key] === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = originalValues[key]
      }
    }
  })

  it('行が存在しない場合は blocked を返す (fail-closed)', async () => {
    const prisma = createMockPrisma(null)

    const result = await checkRelabelStorageCircuitBreaker(prisma, { now: NOW })

    expect(result).toEqual({ status: 'blocked', availableGib: null, usedPercent: null })
  })

  it('measuredAt が既定の maxStaleSeconds (180秒) を超えて古い場合は blocked を返す', async () => {
    const staleMeasuredAt = new Date(NOW.getTime() - 181_000)
    const prisma = createMockPrisma({
      availableGib: 500,
      usedPercent: 10,
      measuredAt: staleMeasuredAt,
    })

    const result = await checkRelabelStorageCircuitBreaker(prisma, { now: NOW })

    expect(result.status).toBe('blocked')
  })

  it('blocked 条件 (空き容量不足) を満たす場合は blocked を返す', async () => {
    const prisma = createMockPrisma({ availableGib: 99, usedPercent: 10, measuredAt: NOW })

    const result = await checkRelabelStorageCircuitBreaker(prisma, { now: NOW })

    expect(result).toEqual({ status: 'blocked', availableGib: 99, usedPercent: 10 })
  })

  it('blocked 条件 (使用率過多) を満たす場合は blocked を返す', async () => {
    const prisma = createMockPrisma({ availableGib: 500, usedPercent: 80, measuredAt: NOW })

    const result = await checkRelabelStorageCircuitBreaker(prisma, { now: NOW })

    expect(result.status).toBe('blocked')
  })

  it('直前が blocked で復帰条件を満たさない場合は blocked を維持する (hysteresis)', async () => {
    const blockedPrisma = createMockPrisma({ availableGib: 99, usedPercent: 10, measuredAt: NOW })
    await checkRelabelStorageCircuitBreaker(blockedPrisma, { now: NOW })

    // blocked しきい値 (< 100 GiB) は脱したが、復帰しきい値 (> 120 GiB) にはまだ届かない
    const recoveringPrisma = createMockPrisma({
      availableGib: 110,
      usedPercent: 10,
      measuredAt: NOW,
    })
    const result = await checkRelabelStorageCircuitBreaker(recoveringPrisma, { now: NOW })

    expect(result.status).toBe('blocked')
  })

  it('直前が blocked でも復帰条件を満たせば ok/warning へ戻る', async () => {
    const blockedPrisma = createMockPrisma({ availableGib: 99, usedPercent: 10, measuredAt: NOW })
    await checkRelabelStorageCircuitBreaker(blockedPrisma, { now: NOW })

    const recoveredPrisma = createMockPrisma({
      availableGib: 200,
      usedPercent: 10,
      measuredAt: NOW,
    })
    const result = await checkRelabelStorageCircuitBreaker(recoveredPrisma, { now: NOW })

    expect(result.status).toBe('ok')
  })

  it('warning 条件のみを満たす場合は warning を返す (blocked にはしない)', async () => {
    const prisma = createMockPrisma({ availableGib: 119, usedPercent: 10, measuredAt: NOW })

    const result = await checkRelabelStorageCircuitBreaker(prisma, { now: NOW })

    expect(result.status).toBe('warning')
  })

  it('どちらの条件も満たさない場合は ok を返す', async () => {
    const prisma = createMockPrisma({ availableGib: 500, usedPercent: 10, measuredAt: NOW })

    const result = await checkRelabelStorageCircuitBreaker(prisma, { now: NOW })

    expect(result).toEqual({ status: 'ok', availableGib: 500, usedPercent: 10 })
  })
})
