import { describe, expect, it, vi } from 'vitest'
import { Prisma, type PrismaClient } from '../generated/prisma'
import { toAccountProfileInput, type RawUserResult } from 'twitter-client'
import {
  recordRecentTweetsFetchFailure,
  recordRecentTweetsFetchSuccess,
  upsertAccount,
  upsertAccountsBulk,
  type AccountProfileInput,
} from './account-repository'

const sampleInput: AccountProfileInput = {
  id: '123',
  screenName: 'test_user',
  displayName: 'Test User',
  bio: 'test bio',
  profileImageUrl: 'https://example.com/a.png',
  followersCount: 10,
  followingCount: 5,
  tweetCount: 100,
  accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
  location: null,
  url: null,
  isBlueVerified: false,
  verifiedType: null,
  professionalType: null,
  parodyCommentaryFanLabel: null,
}

function makeInput(id: string, overrides: Partial<AccountProfileInput> = {}): AccountProfileInput {
  return {
    ...sampleInput,
    id,
    screenName: `user_${id}`,
    displayName: `User ${id}`,
    ...overrides,
  }
}

function makeKnownRequestError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('mock error', {
    code,
    clientVersion: '6.19.3',
    meta,
  })
}

function makePrisma(existing: Record<string, unknown> | null) {
  const queryRaw = vi.fn().mockResolvedValue([{ id: sampleInput.id }])
  const findUnique = vi.fn().mockResolvedValue(existing)
  const findUniqueOrThrow = vi.fn().mockResolvedValue({ ...sampleInput, crawlState: null })
  const prisma = {
    $queryRaw: queryRaw,
    account: { findUnique, findUniqueOrThrow },
  } as unknown as PrismaClient
  return { prisma, queryRaw, findUnique, findUniqueOrThrow }
}

describe('upsertAccount', () => {
  it('upserts with a single statement and reads the account back together with its crawl state', async () => {
    const { prisma, queryRaw, findUniqueOrThrow } = makePrisma(null)

    const { account } = await upsertAccount(prisma, sampleInput)

    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: '123' },
      include: { crawlState: true },
    })
    expect(account.id).toBe('123')
  })

  it('skips the change-detection lookup and returns changed: false when detectChange is not requested', async () => {
    const { prisma, findUnique } = makePrisma(null)

    const { changed } = await upsertAccount(prisma, sampleInput)

    expect(findUnique).not.toHaveBeenCalled()
    expect(changed).toBe(false)
  })

  it('returns changed: false when no bundle-relevant field differs from the existing row', async () => {
    const existing = {
      screenName: sampleInput.screenName,
      displayName: sampleInput.displayName,
      bio: sampleInput.bio,
      followersCount: sampleInput.followersCount,
      followingCount: sampleInput.followingCount,
      tweetCount: sampleInput.tweetCount,
      isBlueVerified: sampleInput.isBlueVerified,
      verifiedType: sampleInput.verifiedType,
      professionalType: sampleInput.professionalType,
      parodyCommentaryFanLabel: sampleInput.parodyCommentaryFanLabel,
    }
    const { prisma } = makePrisma(existing)

    const { changed } = await upsertAccount(prisma, sampleInput, { detectChange: true })

    expect(changed).toBe(false)
  })

  it('returns changed: true when a bundle-relevant field (e.g. followersCount) differs', async () => {
    const existing = {
      screenName: sampleInput.screenName,
      displayName: sampleInput.displayName,
      bio: sampleInput.bio,
      followersCount: 1,
      followingCount: sampleInput.followingCount,
      tweetCount: sampleInput.tweetCount,
      isBlueVerified: sampleInput.isBlueVerified,
      verifiedType: sampleInput.verifiedType,
      professionalType: sampleInput.professionalType,
      parodyCommentaryFanLabel: sampleInput.parodyCommentaryFanLabel,
    }
    const { prisma } = makePrisma(existing)

    const { changed } = await upsertAccount(prisma, sampleInput, { detectChange: true })

    expect(changed).toBe(true)
  })

  it('returns changed: true for a brand-new account (no existing row)', async () => {
    const { prisma } = makePrisma(null)

    const { changed } = await upsertAccount(prisma, sampleInput, { detectChange: true })

    expect(changed).toBe(true)
  })
})

describe('recordRecentTweetsFetchSuccess / recordRecentTweetsFetchFailure', () => {
  it('writes success status and both timestamps to AccountCrawlState', async () => {
    const update = vi.fn().mockResolvedValue({})
    const prisma = { accountCrawlState: { update } } as unknown as PrismaClient
    const fetchedAt = new Date('2026-01-02T03:04:05.000Z')

    await recordRecentTweetsFetchSuccess(prisma, '123', fetchedAt)

    expect(update).toHaveBeenCalledWith({
      where: { accountId: '123' },
      data: {
        lastRecentTweetsAttemptedAt: fetchedAt,
        lastRecentTweetsFetchedAt: fetchedAt,
        recentTweetsFetchStatus: 'success',
      },
    })
  })

  it('writes failed status without touching lastRecentTweetsFetchedAt', async () => {
    const update = vi.fn().mockResolvedValue({})
    const prisma = { accountCrawlState: { update } } as unknown as PrismaClient
    const attemptedAt = new Date('2026-01-02T03:04:05.000Z')

    await recordRecentTweetsFetchFailure(prisma, '123', attemptedAt)

    expect(update).toHaveBeenCalledWith({
      where: { accountId: '123' },
      data: { lastRecentTweetsAttemptedAt: attemptedAt, recentTweetsFetchStatus: 'failed' },
    })
  })
})

describe('upsertAccountsBulk', () => {
  it('upserts multiple accounts in a single round trip and returns the succeeded ids', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: '1' }, { id: '2' }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await upsertAccountsBulk(prisma, [makeInput('1'), makeInput('2')])

    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(result).toEqual(new Set(['1', '2']))
  })

  it('returns an empty set without querying when given no inputs', async () => {
    const queryRaw = vi.fn()
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await upsertAccountsBulk(prisma, [])

    expect(queryRaw).not.toHaveBeenCalled()
    expect(result).toEqual(new Set())
  })

  it('deduplicates by id and sends exactly one row per id (last occurrence wins)', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: '1' }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await upsertAccountsBulk(prisma, [
      makeInput('1', { screenName: 'first' }),
      makeInput('1', { screenName: 'second' }),
    ])

    const callArgs = queryRaw.mock.calls[0] as unknown[]
    const idsArrayArg = callArgs.find(
      (arg) => Array.isArray(arg) && arg.length === 1 && arg[0] === '1',
    )
    expect(idsArrayArg).toBeDefined()
  })
})

describe('upsertAccountsBulk bisection fallback', () => {
  it('bisects on a row-local error (NOT NULL violation) and succeeds for the valid rows', async () => {
    const queryRaw = vi
      .fn()
      .mockRejectedValueOnce(makeKnownRequestError('P2010', { code: '23502' }))
      .mockResolvedValueOnce([{ id: '1' }])
      .mockRejectedValueOnce(makeKnownRequestError('P2010', { code: '23502' }))
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await upsertAccountsBulk(prisma, [makeInput('1'), makeInput('2')])

    expect(result).toEqual(new Set(['1']))
    expect(queryRaw).toHaveBeenCalledTimes(3)
  })

  it('rethrows immediately on a systemic error without bisecting', async () => {
    const queryRaw = vi
      .fn()
      .mockRejectedValueOnce(makeKnownRequestError('P2010', { code: '40P01' }))
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await expect(upsertAccountsBulk(prisma, [makeInput('1'), makeInput('2')])).rejects.toThrow()
    expect(queryRaw).toHaveBeenCalledTimes(1)
  })

  it('treats an unrecognized SQLSTATE as systemic and rethrows without bisecting', async () => {
    const queryRaw = vi
      .fn()
      .mockRejectedValueOnce(makeKnownRequestError('P2010', { code: '99999' }))
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await expect(upsertAccountsBulk(prisma, [makeInput('1'), makeInput('2')])).rejects.toThrow()
    expect(queryRaw).toHaveBeenCalledTimes(1)
  })

  it('isolates a single row-local error at a realistic batch size without discarding valid rows', async () => {
    const batchSize = 64
    const badId = '37'
    const inputs = Array.from({ length: batchSize }, (_, i) => makeInput(String(i)))

    // $queryRaw の第2引数以降が UNNEST 対象の配列であり、先頭が id 配列になる。
    const queryRaw = vi.fn().mockImplementation((_template: unknown, ...values: unknown[]) => {
      const ids = values[0] as string[]
      if (ids.includes(badId)) {
        return Promise.reject(makeKnownRequestError('P2010', { code: '23502' }))
      }
      return Promise.resolve(ids.map((id) => ({ id })))
    })
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await upsertAccountsBulk(prisma, inputs)

    const expected = new Set(inputs.map((i) => i.id).filter((id) => id !== badId))
    expect(result).toEqual(expected)
  })
})

describe('NUL を含むプロフィールの upsert', () => {
  const rawUser: RawUserResult = {
    restId: '900',
    legacy: {
      screenName: 'nul_user',
      name: 'Nul\u0000 User',
      description: 'bio\u0000 text',
      followersCount: 1,
      friendsCount: 1,
      statusesCount: 1,
      createdAt: 'Wed Jan 01 00:00:00 +0000 2020',
      profileImageUrlHttps: null,
      location: 'Lo\u0000c',
      url: 'https://example.test/\u0000u',
    },
    isBlueVerified: false,
    verifiedType: null,
    professionalType: null,
    parodyCommentaryFanLabel: null,
  }

  it('upsertAccount の query パラメータに NUL が残らない', async () => {
    const { prisma, queryRaw } = makePrisma(null)

    await upsertAccount(prisma, toAccountProfileInput(rawUser))

    const values = (queryRaw.mock.calls[0] as unknown[]).slice(1).flat()
    expect(values).toContain('Nul User')
    expect(values).toContain('bio text')
    expect(values.filter((v) => typeof v === 'string' && v.includes('\u0000'))).toEqual([])
  })

  it('bulk upsert の query パラメータに NUL が残らない', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: '900' }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await upsertAccountsBulk(prisma, [toAccountProfileInput(rawUser)])

    const values = (queryRaw.mock.calls[0] as unknown[]).slice(1).flat()
    expect(values).toContain('Nul User')
    expect(values).toContain('bio text')
    expect(values.filter((v) => typeof v === 'string' && v.includes('\u0000'))).toEqual([])
  })
})
