import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as childProcess from 'node:child_process'
import type { PrismaClient } from '../generated/prisma'
import { getRelabelStorageMaxStaleSeconds } from '../config/env'
import {
  getStorageGuardIntervalSeconds,
  parseStorageGuardOutput,
  runStorageGuardCycleOnce,
} from './storage-guard-cycle'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

function createMockPrisma() {
  const upsert = vi.fn().mockResolvedValue({})
  const prisma = { storageCapacityState: { upsert } } as unknown as PrismaClient
  return { prisma, upsert }
}

function mockSpawnResult(overrides: {
  status?: number | null
  stdout?: string
  stderr?: string
  error?: Error
}) {
  vi.mocked(childProcess.spawnSync).mockReturnValue({
    status: overrides.status ?? 0,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    signal: null,
    pid: 1,
    output: [null, overrides.stdout ?? '', overrides.stderr ?? ''],
    error: overrides.error,
  } as unknown as ReturnType<typeof childProcess.spawnSync>)
}

describe('getStorageGuardIntervalSeconds', () => {
  it('既定の実行間隔は RELABEL_STORAGE_MAX_STALE_SECONDS の既定値より短い (fail-closed の常時誤検知を防ぐ)', () => {
    expect(getStorageGuardIntervalSeconds()).toBeLessThan(getRelabelStorageMaxStaleSeconds())
  })
})

describe('parseStorageGuardOutput', () => {
  it('抽出できた場合は availableGib/usedPercent を返す', () => {
    const stdout = '[postgres-storage] path=/data/postgres used_percent=42% available_gib=123.4\n'
    expect(parseStorageGuardOutput(stdout)).toEqual({ usedPercent: 42, availableGib: 123.4 })
  })

  it('抽出できない出力では null を返す', () => {
    expect(
      parseStorageGuardOutput('[postgres-storage] could not inspect path: /data/postgres\n'),
    ).toBeNull()
  })
})

describe('runStorageGuardCycleOnce', () => {
  beforeEach(() => {
    vi.mocked(childProcess.spawnSync).mockReset()
  })

  it('終了コード0の正常な出力から抽出した値でStorageCapacityStateをupsertする', async () => {
    mockSpawnResult({
      status: 0,
      stdout: '[postgres-storage] path=/data/postgres used_percent=42% available_gib=123.4\n',
    })
    const { prisma, upsert } = createMockPrisma()

    await runStorageGuardCycleOnce(prisma)

    expect(upsert).toHaveBeenCalledTimes(1)
    const call = upsert.mock.calls[0][0] as {
      where: { id: string }
      create: { availableGib: number; usedPercent: number }
      update: { availableGib: number; usedPercent: number }
    }
    expect(call.where.id).toBe('singleton')
    expect(call.create.availableGib).toBe(123.4)
    expect(call.create.usedPercent).toBe(42)
    expect(call.update.availableGib).toBe(123.4)
    expect(call.update.usedPercent).toBe(42)
  })

  it('終了コード1の閾値超過でも計測行があれば直ちにStorageCapacityStateをupsertする', async () => {
    mockSpawnResult({
      status: 1,
      stdout: '[postgres-storage] path=/data/postgres used_percent=85% available_gib=90.0\n',
      stderr: '[postgres-storage] usage is at or above 80%\n',
    })
    const { prisma, upsert } = createMockPrisma()

    await runStorageGuardCycleOnce(prisma)

    expect(upsert).toHaveBeenCalledTimes(1)
    const call = upsert.mock.calls[0][0] as {
      create: { availableGib: number; usedPercent: number }
    }
    expect(call.create.availableGib).toBe(90)
    expect(call.create.usedPercent).toBe(85)
  })

  it('終了コード2の設定・df自体の失敗では計測行が無くupsertしない', async () => {
    mockSpawnResult({
      status: 2,
      stdout: '',
      stderr: '[postgres-storage] could not inspect path: /data/postgres\n',
    })
    const { prisma, upsert } = createMockPrisma()

    await runStorageGuardCycleOnce(prisma)

    expect(upsert).not.toHaveBeenCalled()
  })

  it('ENOENTのようにプロセス自体を起動できない場合はupsertせず例外を握りつぶさない', async () => {
    const error = Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' })
    mockSpawnResult({ status: null, error })
    const { prisma, upsert } = createMockPrisma()

    await expect(runStorageGuardCycleOnce(prisma)).resolves.toBeUndefined()

    expect(upsert).not.toHaveBeenCalled()
  })
})
