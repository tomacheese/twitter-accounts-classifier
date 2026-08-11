import { describe, expect, it, vi } from 'vitest'
import { Prisma, type PrismaClient } from '../generated/prisma'
import {
  upsertAccount,
  upsertAccountsBulk,
  resolveAccountIdsByUsername,
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

describe('upsertAccount', () => {
  it('upserts keyed by account id, setting lastCrawledAt on update', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: '123' })
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { account: { upsert, findUnique } } as unknown as PrismaClient

    await upsertAccount(prisma, sampleInput)

    expect(upsert).toHaveBeenCalledTimes(1)
    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.where).toEqual({ id: '123' })
    expect((call.create as Record<string, unknown>).id).toBe('123')
    expect((call.update as Record<string, unknown>).screenName).toBe('test_user')
    expect((call.update as Record<string, unknown>).lastCrawledAt).toBeInstanceOf(Date)
  })

  it('skips the change-detection lookup and returns changed: false when detectChange is not requested', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: '123' })
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { account: { upsert, findUnique } } as unknown as PrismaClient

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
    const findUnique = vi.fn().mockResolvedValue(existing)
    const upsert = vi.fn().mockResolvedValue({ id: sampleInput.id, ...existing })
    const prisma = { account: { upsert, findUnique } } as unknown as PrismaClient

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
    const findUnique = vi.fn().mockResolvedValue(existing)
    const upsert = vi.fn().mockResolvedValue({ ...sampleInput })
    const prisma = { account: { upsert, findUnique } } as unknown as PrismaClient

    const { changed } = await upsertAccount(prisma, sampleInput, { detectChange: true })

    expect(changed).toBe(true)
  })

  it('returns changed: true for a brand-new account (no existing row)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)
    const upsert = vi.fn().mockResolvedValue({ ...sampleInput })
    const prisma = { account: { upsert, findUnique } } as unknown as PrismaClient

    const { changed } = await upsertAccount(prisma, sampleInput, { detectChange: true })

    expect(changed).toBe(true)
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

describe('resolveAccountIdsByUsername', () => {
  it('screenName が一致する Account の id だけを返す', async () => {
    const prisma = {
      account: {
        findMany: vi.fn().mockResolvedValue([{ id: 'acct-alice' }, { id: 'acct-bob' }]),
      },
    } as unknown as PrismaClient

    const ids = await resolveAccountIdsByUsername(prisma, ['alice', 'bob'])

    expect(ids).toEqual(['acct-alice', 'acct-bob'])
    expect(prisma.account.findMany).toHaveBeenCalledWith({
      where: { screenName: { in: ['alice', 'bob'] } },
      select: { id: true },
    })
  })

  it('usernames が空の場合はクエリを発行せず空配列を返す', async () => {
    const findMany = vi.fn()
    const prisma = { account: { findMany } } as unknown as PrismaClient

    const ids = await resolveAccountIdsByUsername(prisma, [])

    expect(ids).toEqual([])
    expect(findMany).not.toHaveBeenCalled()
  })
})
