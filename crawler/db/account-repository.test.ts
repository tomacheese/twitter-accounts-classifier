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

    const { changed } = await upsertAccount(prisma, sampleInput)

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

    const { changed } = await upsertAccount(prisma, sampleInput)

    expect(changed).toBe(true)
  })

  it('returns changed: true for a brand-new account (no existing row)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)
    const upsert = vi.fn().mockResolvedValue({ ...sampleInput })
    const prisma = { account: { upsert, findUnique } } as unknown as PrismaClient

    const { changed } = await upsertAccount(prisma, sampleInput)

    expect(changed).toBe(true)
  })
})
