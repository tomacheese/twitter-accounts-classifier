import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import * as accountRepository from './db/account-repository'
import * as tweetRepository from './db/tweet-repository'
import * as labelRepository from './db/label-repository'
import * as workItemRepository from './db/analysis-work-item-repository'
import { createPersistAccountFn, createPersistTweetsFn } from './crawl'

describe('createPersistAccountFn', () => {
  it('classification-relevant フィールドが変化し、既存ラベルがある account だけ account_relabel を要求する', async () => {
    vi.spyOn(accountRepository, 'upsertAccount').mockResolvedValue({
      account: { id: 'acct-1' } as never,
      changed: true,
    })
    vi.spyOn(labelRepository, 'filterAccountIdsWithExistingLabels').mockResolvedValue(
      new Set(['acct-1']),
    )
    const requestSpy = vi.spyOn(workItemRepository, 'requestAccountRelabel').mockResolvedValue()

    const prisma = {} as PrismaClient
    const persistAccount = createPersistAccountFn(prisma)
    await persistAccount({ id: 'acct-1' } as never)

    expect(requestSpy).toHaveBeenCalledWith(prisma, 'acct-1')
  })

  it('変化がなければ account_relabel を要求しない', async () => {
    vi.spyOn(accountRepository, 'upsertAccount').mockResolvedValue({
      account: { id: 'acct-1' } as never,
      changed: false,
    })
    const requestSpy = vi.spyOn(workItemRepository, 'requestAccountRelabel').mockResolvedValue()

    const prisma = {} as PrismaClient
    const persistAccount = createPersistAccountFn(prisma)
    await persistAccount({ id: 'acct-1' } as never)

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
    const persistAccount = createPersistAccountFn(prisma)
    await persistAccount({ id: 'acct-1' } as never)

    expect(requestSpy).not.toHaveBeenCalled()
  })
})

describe('createPersistTweetsFn', () => {
  it('変化があった tweet の accountId のうち、既存ラベルがあるものだけ account_relabel を要求する', async () => {
    vi.spyOn(tweetRepository, 'upsertTweets').mockResolvedValue([
      { tweet: { id: 't1', accountId: 'acct-1' } as never, changed: true },
      { tweet: { id: 't2', accountId: 'acct-2' } as never, changed: false },
    ])
    vi.spyOn(labelRepository, 'filterAccountIdsWithExistingLabels').mockResolvedValue(
      new Set(['acct-1']),
    )
    const requestSpy = vi.spyOn(workItemRepository, 'requestAccountRelabelBulk').mockResolvedValue()

    const prisma = {} as PrismaClient
    const persistTweets = createPersistTweetsFn(prisma)
    await persistTweets([] as never)

    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(requestSpy).toHaveBeenCalledWith(prisma, ['acct-1'])
  })
})
