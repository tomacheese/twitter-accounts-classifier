import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import {
  upsertTweet,
  upsertTweets,
  loadRecentTweetsForAccounts,
  findMissingTweetIds,
  type TweetInput,
} from './tweet-repository'

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
    expect(results.map((r) => r.tweet.id)).toEqual(['t1', 't3'])
  })
})

describe('upsertTweet bundle-relevant change detection', () => {
  it('returns changed: true for a brand-new tweet', async () => {
    const upsert = vi.fn().mockResolvedValue({ ...sampleTweet })
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    const { changed } = await upsertTweet(prisma, sampleTweet)

    expect(changed).toBe(true)
  })

  it('returns changed: false when the merged result matches the existing row exactly', async () => {
    const existing = {
      isPromoted: false,
      isPaidPromotion: false,
      expandedUrls: [],
      hasAiGeneratedMedia: false,
      aiGeneratedDetectionSource: null,
      foreignVideoSourceCount: null,
      quotedTweetId: null,
      quotedTweetAuthorId: null,
      quotedTweetHasVideo: null,
      fullText: sampleTweet.fullText,
      createdAt: sampleTweet.createdAt,
      retweetCount: sampleTweet.retweetCount,
      likeCount: sampleTweet.likeCount,
      isReply: sampleTweet.isReply,
      isRetweet: sampleTweet.isRetweet,
      inReplyToTweetId: sampleTweet.inReplyToTweetId,
    }
    const findUnique = vi.fn().mockResolvedValue(existing)
    const upsert = vi.fn().mockResolvedValue({ id: sampleTweet.id, ...existing })
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    const { changed } = await upsertTweet(prisma, { ...sampleTweet, hasAiGeneratedMedia: null })

    expect(changed).toBe(false)
  })

  it('returns changed: true when merge preserves a previously-true isPaidPromotion the input lost', async () => {
    const existing = {
      isPromoted: false,
      isPaidPromotion: true,
      expandedUrls: [],
      hasAiGeneratedMedia: null,
      aiGeneratedDetectionSource: null,
      foreignVideoSourceCount: null,
      quotedTweetId: null,
      quotedTweetAuthorId: null,
      quotedTweetHasVideo: null,
      fullText: 'old text',
      createdAt: sampleTweet.createdAt,
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: false,
      inReplyToTweetId: null,
    }
    const findUnique = vi.fn().mockResolvedValue(existing)
    const upsert = vi
      .fn()
      .mockResolvedValue({ id: sampleTweet.id, ...existing, fullText: sampleTweet.fullText })
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    const { changed } = await upsertTweet(prisma, { ...sampleTweet, isPaidPromotion: false })

    expect(changed).toBe(true)
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

describe('upsertTweet expanded URLs', () => {
  it('preserves previously observed expanded URLs while adding newly observed URLs', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 't1' })
    const findUnique = vi.fn().mockResolvedValue({
      expandedUrls: ['https://example.com/old'],
    })
    const prisma = { tweet: { upsert, findUnique } } as unknown as PrismaClient

    await upsertTweet(prisma, {
      ...sampleTweet,
      expandedUrls: ['https://example.com/new'],
    })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.update).toMatchObject({
      expandedUrls: ['https://example.com/new', 'https://example.com/old'],
    })
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

describe('loadRecentTweetsForAccounts', () => {
  it('accountIds が空の場合は DB へ問い合わせず空 Map を返す', async () => {
    const queryRaw = vi.fn()
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await loadRecentTweetsForAccounts(prisma, [], 20)

    expect(result).toEqual(new Map())
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('account ごとの直近ツイートを 1 回の queryRaw でまとめて取得し account 単位にグルーピングする', async () => {
    const rows = [
      { id: 't1', accountId: 'u1', createdAt: new Date('2026-01-02T00:00:00Z') },
      { id: 't2', accountId: 'u1', createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 't3', accountId: 'u2', createdAt: new Date('2026-01-03T00:00:00Z') },
    ]
    const queryRaw = vi.fn().mockResolvedValue(rows)
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await loadRecentTweetsForAccounts(prisma, ['u1', 'u2', 'u3'], 20)

    expect(queryRaw).toHaveBeenCalledTimes(1)
    const sql = (queryRaw.mock.calls[0][0] as unknown[]).join('')
    expect(sql).toContain('CROSS JOIN LATERAL')
    expect(sql).toContain('ORDER BY "createdAt" DESC')
    expect(result.get('u1')).toEqual([rows[0], rows[1]])
    expect(result.get('u2')).toEqual([rows[2]])
    // u3 はツイート 0 件のため Map にキー自体が存在しない (呼び出し元は ?? [] で扱う)。
    expect(result.has('u3')).toBe(false)
  })
})

describe('findMissingTweetIds', () => {
  it('returns only the ids not present in the Tweet table', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'known1' }])
    const prisma = { tweet: { findMany } } as unknown as PrismaClient

    const result = await findMissingTweetIds(prisma, ['known1', 'missing1', 'missing2'])

    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['known1', 'missing1', 'missing2'] } },
      select: { id: true },
    })
    expect(result).toEqual(['missing1', 'missing2'])
  })

  it('returns an empty array without querying the database when given no ids', async () => {
    const findMany = vi.fn()
    const prisma = { tweet: { findMany } } as unknown as PrismaClient

    const result = await findMissingTweetIds(prisma, [])

    expect(findMany).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })
})
