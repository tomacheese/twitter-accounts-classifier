import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { upsertTweet, upsertTweets, type TweetInput } from './tweet-repository'

const sampleTweet: TweetInput = {
  id: 't1',
  accountId: 'u1',
  fullText: 'hello world',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  retweetCount: 3,
  likeCount: 10,
  replyCount: 1,
  quoteCount: 0,
  isReply: false,
  inReplyToTweetId: null,
  isAuthorReply: false,
  isRetweet: false,
  retweetedTweetId: null,
  isPromoted: false,
  isPaidPromotion: false,
  hasAiGeneratedMedia: false,
  aiGeneratedDetectionSource: null,
  foreignVideoSourceCount: null,
  quotedTweetId: null,
  quotedTweetAuthorId: null,
  quotedTweetHasVideo: null,
  source: 'recommended',
}

describe('upsertTweet', () => {
  it('upserts a single tweet keyed by id', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweet(prisma, sampleTweet)

    expect(upsert).toHaveBeenCalledTimes(1)
    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.where).toEqual({ id: 't1' })
  })
})

describe('upsertTweets', () => {
  it('upserts every tweet in the batch', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweets(prisma, [sampleTweet, { ...sampleTweet, id: 't2' }])

    expect(upsert).toHaveBeenCalledTimes(2)
  })
})

describe('upsertTweets error isolation', () => {
  it('continues upserting the remaining tweets after one upsert fails', async () => {
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ id: 't1' })
      .mockRejectedValueOnce(new Error('foreign key violation'))
      .mockResolvedValueOnce({ id: 't3' })
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    const results = await upsertTweets(prisma, [
      sampleTweet,
      { ...sampleTweet, id: 't2' },
      { ...sampleTweet, id: 't3' },
    ])

    expect(upsert).toHaveBeenCalledTimes(3)
    expect(results.map((t) => t.id)).toEqual(['t1', 't3'])
  })
})

describe('upsertTweet ad-disclosure fields', () => {
  it('passes isPromoted and isPaidPromotion through to both create and update', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweet(prisma, { ...sampleTweet, isPromoted: true, isPaidPromotion: true })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.create).toMatchObject({ isPromoted: true, isPaidPromotion: true })
    expect(call.update).toMatchObject({ isPromoted: true, isPaidPromotion: true })
  })

  it('does not let a re-crawl lacking ad metadata flip a previously-true isPromoted/isPaidPromotion back to false', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue({ isPromoted: true, isPaidPromotion: true })
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweet(prisma, { ...sampleTweet, isPromoted: false, isPaidPromotion: false })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.update).toMatchObject({ isPromoted: true, isPaidPromotion: true })
  })
})

describe('upsertTweet quoted-tweet fields', () => {
  it('passes quotedTweetId, quotedTweetAuthorId and quotedTweetHasVideo through to both create and update', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweet(prisma, {
      ...sampleTweet,
      quotedTweetId: 'quoted1',
      quotedTweetAuthorId: 'bob',
      quotedTweetHasVideo: true,
    })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.create).toMatchObject({
      quotedTweetId: 'quoted1',
      quotedTweetAuthorId: 'bob',
      quotedTweetHasVideo: true,
    })
    expect(call.update).toMatchObject({
      quotedTweetId: 'quoted1',
      quotedTweetAuthorId: 'bob',
      quotedTweetHasVideo: true,
    })
  })

  it('does not let a re-crawl that fails to resolve the quoted tweet erase a previously-known value, like the ad-disclosure fields', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue({
      quotedTweetId: 'quoted1',
      quotedTweetAuthorId: 'bob',
      quotedTweetHasVideo: true,
    })
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweet(prisma, {
      ...sampleTweet,
      quotedTweetId: null,
      quotedTweetAuthorId: null,
      quotedTweetHasVideo: null,
    })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.update).toMatchObject({
      quotedTweetId: 'quoted1',
      quotedTweetAuthorId: 'bob',
      quotedTweetHasVideo: true,
    })
  })

  it('overwrites a previously-known quoted-tweet value once the re-crawl resolves a different one', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue({
      quotedTweetId: 'quoted1',
      quotedTweetAuthorId: 'bob',
      quotedTweetHasVideo: true,
    })
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweet(prisma, {
      ...sampleTweet,
      quotedTweetId: 'quoted2',
      quotedTweetAuthorId: 'carol',
      quotedTweetHasVideo: false,
    })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.update).toMatchObject({
      quotedTweetId: 'quoted2',
      quotedTweetAuthorId: 'carol',
      quotedTweetHasVideo: false,
    })
  })
})

describe('upsertTweet foreign-video-source count', () => {
  it('passes the source-attributed video count through to both create and update', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweet(prisma, { ...sampleTweet, foreignVideoSourceCount: 2 })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.create).toMatchObject({ foreignVideoSourceCount: 2 })
    expect(call.update).toMatchObject({ foreignVideoSourceCount: 2 })
  })

  it('does not let a re-crawl without the provenance field erase a previously-known count', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue({ foreignVideoSourceCount: 2 })
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweet(prisma, { ...sampleTweet, foreignVideoSourceCount: null })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.update).toMatchObject({ foreignVideoSourceCount: 2 })
  })

  it('does not let a zero count erase a previously-known source-attributed video', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue({ foreignVideoSourceCount: 2 })
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweet(prisma, { ...sampleTweet, foreignVideoSourceCount: 0 })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.update).toMatchObject({ foreignVideoSourceCount: 2 })
  })
})
