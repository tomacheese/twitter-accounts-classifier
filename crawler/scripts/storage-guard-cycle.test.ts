import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as childProcess from 'node:child_process'
import type { PrismaClient } from '../generated/prisma'
import { parseStorageGuardOutput, runStorageGuardCycleOnce } from './storage-guard-cycle'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

function createMockPrisma() {
  const upsert = vi.fn().mockResolvedValue({})
  const prisma = { storageCapacityState: { upsert } } as unknown as PrismaClient
  return { prisma, upsert }
}

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
    vi.mocked(childProcess.execFileSync).mockReset()
  })

  it('正常な出力から抽出した値でStorageCapacityStateをupsertする', async () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(
      '[postgres-storage] path=/data/postgres used_percent=42% available_gib=123.4\n',
    )
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

  it('df失敗を模した抽出不能な出力ではupsertしない', async () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(
      '[postgres-storage] could not inspect path: /data/postgres\n',
    )
    const { prisma, upsert } = createMockPrisma()

    await runStorageGuardCycleOnce(prisma)

    expect(upsert).not.toHaveBeenCalled()
  })

  it('子プロセスが非ゼロ終了で例外を投げても、例外のstdoutから抽出できれば通常どおりupsertする', async () => {
    const error = Object.assign(new Error('Command failed'), {
      stdout: '[postgres-storage] path=/data/postgres used_percent=85% available_gib=90.0\n',
    })
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw error
    })
    const { prisma, upsert } = createMockPrisma()

    await runStorageGuardCycleOnce(prisma)

    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('ENOENTのようにstdout自体を持たない例外ではupsertせず例外を握りつぶさない', async () => {
    const error = Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' })
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw error
    })
    const { prisma, upsert } = createMockPrisma()

    await expect(runStorageGuardCycleOnce(prisma)).resolves.toBeUndefined()

    expect(upsert).not.toHaveBeenCalled()
  })
})
