import { describe, expect, it, vi } from 'vitest'
import { Prisma, type PrismaClient } from '../generated/prisma'
import { upsertAccount, upsertAccountsBulk, type AccountProfileInput } from './account-repository'

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

describe('upsertAccount', () => {
  it('upserts keyed by account id, setting lastCrawledAt on update', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: '123' })
    const prisma = { account: { upsert } } as unknown as PrismaClient

    await upsertAccount(prisma, sampleInput)

    expect(upsert).toHaveBeenCalledTimes(1)
    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.where).toEqual({ id: '123' })
    expect((call.create as Record<string, unknown>).id).toBe('123')
    expect((call.update as Record<string, unknown>).screenName).toBe('test_user')
    expect((call.update as Record<string, unknown>).lastCrawledAt).toBeInstanceOf(Date)
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
})
