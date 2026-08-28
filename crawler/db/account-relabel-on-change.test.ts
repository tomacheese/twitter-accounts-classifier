import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import * as accountRepository from './account-repository'
import * as labelRepository from './label-repository'
import * as workItemRepository from './analysis-work-item-repository'
import { upsertAccountRequestingRelabelIfChanged } from './account-relabel-on-change'

const input = { id: 'acct-1' } as never

describe('upsertAccountRequestingRelabelIfChanged', () => {
  it('ラベル評価に影響するフィールドが変化し、既存ラベルがある account には account_relabel を要求する', async () => {
    vi.spyOn(accountRepository, 'upsertAccount').mockResolvedValue({
      account: { id: 'acct-1' } as never,
      changed: true,
    })
    vi.spyOn(labelRepository, 'filterAccountIdsWithExistingLabels').mockResolvedValue(
      new Set(['acct-1']),
    )
    const requestSpy = vi.spyOn(workItemRepository, 'requestAccountRelabel').mockResolvedValue()

    const prisma = {} as PrismaClient
    await upsertAccountRequestingRelabelIfChanged(prisma, input)

    expect(requestSpy).toHaveBeenCalledWith(prisma, 'acct-1')
  })

  it('変化がなければ account_relabel を要求しない', async () => {
    vi.spyOn(accountRepository, 'upsertAccount').mockResolvedValue({
      account: { id: 'acct-1' } as never,
      changed: false,
    })
    const filterSpy = vi.spyOn(labelRepository, 'filterAccountIdsWithExistingLabels')
    const requestSpy = vi.spyOn(workItemRepository, 'requestAccountRelabel').mockResolvedValue()

    const prisma = {} as PrismaClient
    await upsertAccountRequestingRelabelIfChanged(prisma, input)

    expect(filterSpy).not.toHaveBeenCalled()
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('変化はあっても既存ラベルがなければ account_relabel を要求しない', async () => {
    vi.spyOn(accountRepository, 'upsertAccount').mockResolvedValue({
      account: { id: 'acct-1' } as never,
      changed: true,
    })
    vi.spyOn(labelRepository, 'filterAccountIdsWithExistingLabels').mockResolvedValue(new Set())
    const requestSpy = vi.spyOn(workItemRepository, 'requestAccountRelabel').mockResolvedValue()

    const prisma = {} as PrismaClient
    await upsertAccountRequestingRelabelIfChanged(prisma, input)

    expect(requestSpy).not.toHaveBeenCalled()
  })
})
