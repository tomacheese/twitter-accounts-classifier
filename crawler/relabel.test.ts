import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import { LabelRuleRegistry } from './labels/registry'
import * as relabelWorker from './relabel-worker'
import { runRelabelBackfill } from './relabel'

describe('runRelabelBackfill', () => {
  it('テーブルが空になるまで scanForStaleAccounts を呼び続ける', async () => {
    const scanSpy = vi
      .spyOn(relabelWorker, 'scanForStaleAccounts')
      .mockResolvedValueOnce({ scanned: 100, requested: 10, wrapped: false })
      .mockResolvedValueOnce({ scanned: 100, requested: 5, wrapped: false })
      .mockResolvedValueOnce({ scanned: 0, requested: 0, wrapped: false })

    const prisma = {} as PrismaClient
    const result = await runRelabelBackfill(prisma, new LabelRuleRegistry())

    expect(scanSpy).toHaveBeenCalledTimes(3)
    expect(result.accountsScanned).toBe(200)
    expect(result.accountsRequested).toBe(15)
  })

  it('カーソルが先頭に巻き戻った時点で停止する', async () => {
    const scanSpy = vi
      .spyOn(relabelWorker, 'scanForStaleAccounts')
      .mockResolvedValueOnce({ scanned: 100, requested: 10, wrapped: false })
      .mockResolvedValueOnce({ scanned: 100, requested: 5, wrapped: true })

    const prisma = {} as PrismaClient
    const result = await runRelabelBackfill(prisma, new LabelRuleRegistry())

    expect(scanSpy).toHaveBeenCalledTimes(2)
    expect(result.accountsScanned).toBe(200)
    expect(result.accountsRequested).toBe(15)
  })
})
