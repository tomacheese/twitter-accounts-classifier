import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import { LabelRuleRegistry } from './labels/registry'
import * as relabelWorker from './relabel-worker'
import { runRelabelBackfill } from './relabel'

describe('runRelabelBackfill', () => {
  it('カーソルが一巡するまで scanForStaleAccounts を呼び続ける', async () => {
    const scanSpy = vi
      .spyOn(relabelWorker, 'scanForStaleAccounts')
      .mockResolvedValueOnce({ scanned: 100, requested: 10 })
      .mockResolvedValueOnce({ scanned: 100, requested: 5 })
      .mockResolvedValueOnce({ scanned: 0, requested: 0 })

    const prisma = {} as PrismaClient
    const result = await runRelabelBackfill(prisma, new LabelRuleRegistry())

    expect(scanSpy).toHaveBeenCalledTimes(3)
    expect(result.accountsScanned).toBe(200)
    expect(result.accountsRequested).toBe(15)
  })
})
