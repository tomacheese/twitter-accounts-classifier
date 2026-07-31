import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { upsertAccount, type AccountProfileInput } from './account-repository'

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
