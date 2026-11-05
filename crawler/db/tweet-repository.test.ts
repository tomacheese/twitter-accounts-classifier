import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import {
  mergeTweet,
  upsertTweets,
  loadRecentTweetsForAccounts,
  loadPromotedTweetCountsForAccounts,
  findMissingTweetIds,
  findTweetTextsByIds,
  type TweetInput,
} from './tweet-repository'

const sampleTweet: TweetInput = {
  id: '1000001',
  accountId: '2000001',
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
  hasMedia: null,
  conversationId: null,
  hasAiGeneratedMedia: false,
  aiGeneratedDetectionSource: null,
  foreignVideoSourceCount: null,
  quotedTweetId: null,
  quotedTweetAuthorId: null,
  quotedTweetHasVideo: null,
  source: 'recommended',
}

type ExistingRow = Parameters<typeof mergeTweet>[1]

function existingRow(overrides: Partial<NonNullable<ExistingRow>> = {}): NonNullable<ExistingRow> {
  return {
    fullText: sampleTweet.fullText,
    createdAt: sampleTweet.createdAt,
    retweetCount: sampleTweet.retweetCount,
    likeCount: sampleTweet.likeCount,
    replyCount: sampleTweet.replyCount,
    isReply: false,
    conversationId: null,
    isRetweet: false,
    inReplyToTweetId: null,
    isPromoted: false,
    isPaidPromotion: false,
    expandedUrls: [],
    cardDestinationUrls: [],
    cardDestinationUrlsEvaluated: false,
    hasMedia: null,
    hasAiGeneratedMedia: null,
    aiGeneratedDetectionSource: null,
    foreignVideoSourceCount: null,
    quotedTweetAuthorId: null,
    quotedTweetHasVideo: null,
    ...overrides,
  }
}

describe('mergeTweet', () => {
  it('新規 (既存行なし) は入力値をそのまま書き込み値にする', () => {
    const merged = mergeTweet(
      { ...sampleTweet, isPromoted: true, foreignVideoSourceCount: 2, hasMedia: false },
      null,
    )

    expect(merged).toMatchObject({
      isPromoted: true,
      foreignVideoSourceCount: 2,
      hasMedia: false,
      expandedUrls: [],
      cardDestinationUrls: [],
    })
  })

  it('広告メタデータを欠く再取得で、検出済みの isPromoted/isPaidPromotion を false に戻さない', () => {
    const merged = mergeTweet(
      { ...sampleTweet, isPromoted: false, isPaidPromotion: false },
      existingRow({ isPromoted: true, isPaidPromotion: true }),
    )

    expect(merged).toMatchObject({ isPromoted: true, isPaidPromotion: true })
  })

  it('観測済みの URL を保ったまま新しい URL を後ろに足す', () => {
    const merged = mergeTweet(
      {
        ...sampleTweet,
        expandedUrls: ['https://example.com/new', 'https://example.com/old'],
        cardDestinationUrls: ['https://example-shop.test/new'],
        cardDestinationUrlsEvaluated: true,
      },
      existingRow({
        expandedUrls: ['https://example.com/old'],
        cardDestinationUrls: ['https://example-shop.test/old'],
        cardDestinationUrlsEvaluated: true,
      }),
    )

    expect(merged.expandedUrls).toEqual(['https://example.com/old', 'https://example.com/new'])
    expect(merged.cardDestinationUrls).toEqual([
      'https://example-shop.test/old',
      'https://example-shop.test/new',
    ])
  })

  it('Card を評価できなかった再取得で、評価済みフラグを false に戻さない', () => {
    const merged = mergeTweet(
      { ...sampleTweet, cardDestinationUrlsEvaluated: false },
      existingRow({ cardDestinationUrlsEvaluated: true }),
    )

    expect(merged.cardDestinationUrlsEvaluated).toBe(true)
  })

  it('引用ツイートを解決できなかった再取得で、既知の値を消さず、別の値が解決されたら上書きする', () => {
    const known = existingRow({ quotedTweetAuthorId: '3000001', quotedTweetHasVideo: true })

    expect(
      mergeTweet({ ...sampleTweet, quotedTweetAuthorId: null, quotedTweetHasVideo: null }, known),
    ).toMatchObject({ quotedTweetAuthorId: '3000001', quotedTweetHasVideo: true })
    expect(
      mergeTweet(
        { ...sampleTweet, quotedTweetAuthorId: '3000002', quotedTweetHasVideo: false },
        known,
      ),
    ).toMatchObject({ quotedTweetAuthorId: '3000002', quotedTweetHasVideo: false })
  })

  it('出典付き動画数は、入力が欠けても 0 でも既知の値を消さない', () => {
    const known = existingRow({ foreignVideoSourceCount: 2 })

    expect(mergeTweet({ ...sampleTweet, foreignVideoSourceCount: null }, known)).toMatchObject({
      foreignVideoSourceCount: 2,
    })
    expect(mergeTweet({ ...sampleTweet, foreignVideoSourceCount: 0 }, known)).toMatchObject({
      foreignVideoSourceCount: 2,
    })
    expect(mergeTweet({ ...sampleTweet, foreignVideoSourceCount: 3 }, known)).toMatchObject({
      foreignVideoSourceCount: 3,
    })
  })

  it('hasAiGeneratedMedia と hasMedia は、入力が null のとき既知の値を保つ', () => {
    const merged = mergeTweet(
      { ...sampleTweet, hasAiGeneratedMedia: null, hasMedia: null },
      existingRow({ hasAiGeneratedMedia: true, hasMedia: true }),
    )

    expect(merged).toMatchObject({ hasAiGeneratedMedia: true, hasMedia: true })
  })
})

describe('upsertTweets error isolation', () => {
  it('continues upserting the remaining tweets after one upsert fails', async () => {
    const row = (id: string) => ({ ...sampleTweet, id, expandedUrls: [], cardDestinationUrls: [] })
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([row('1000001')])
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce([row('1000003')])
    const prisma = {
      tweet: { findUnique: vi.fn().mockResolvedValue(null) },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const results = await upsertTweets(prisma, [
      sampleTweet,
      { ...sampleTweet, id: '1000002' },
      { ...sampleTweet, id: '1000003' },
    ])

    expect(queryRaw).toHaveBeenCalledTimes(3)
    expect(results.map((r) => r.tweet.id)).toEqual(['1000001', '1000003'])
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
    const sql = (queryRaw.mock.calls[0][0] as { sql: string }).sql
    expect(sql).toContain('CROSS JOIN LATERAL')
    expect(sql).not.toMatch(/CROSS JOIN LATERAL \(\s+SELECT \*\s+FROM "Tweet"/)
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

describe('findTweetTextsByIds', () => {
  it('returns a map of id to fullText for existing tweets, skipping missing ids', async () => {
    const prisma = {
      tweet: {
        findMany: vi.fn().mockResolvedValue([{ id: 't1', fullText: '本文1' }]),
      },
    } as unknown as PrismaClient

    const result = await findTweetTextsByIds(prisma, ['t1', 't2'])

    expect(result.get('t1')).toBe('本文1')
    expect(result.has('t2')).toBe(false)
  })

  it('returns an empty map without querying when ids is empty', async () => {
    const findMany = vi.fn()
    const prisma = { tweet: { findMany } } as unknown as PrismaClient

    const result = await findTweetTextsByIds(prisma, [])

    expect(result.size).toBe(0)
    expect(findMany).not.toHaveBeenCalled()
  })
})

describe('findTweetContextsByIds', () => {
  it('returns parent text and author id in one query', async () => {
    const repository = await import('./tweet-repository')
    expect(repository).toHaveProperty('findTweetContextsByIds')
    const findTweetContextsByIds = (repository as Record<string, unknown>)
      .findTweetContextsByIds as (
      prisma: PrismaClient,
      ids: string[],
    ) => Promise<Map<string, { fullText: string; accountId: string }>>
    const findMany = vi
      .fn()
      .mockResolvedValue([{ id: 't1', fullText: '本文1', accountId: 'author-1' }])
    const prisma = { tweet: { findMany } } as unknown as PrismaClient

    const result = await findTweetContextsByIds(prisma, ['t1', 'missing'])

    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['t1', 'missing'] } },
      select: { id: true, fullText: true, accountId: true },
    })
    expect(result.get('t1')).toEqual({ fullText: '本文1', accountId: 'author-1' })
    expect(result.has('missing')).toBe(false)
  })
})

describe('loadPromotedTweetCountsForAccounts', () => {
  const since = new Date('2026-01-01T00:00:00Z')

  it('accountIds が空の場合は DB へ問い合わせず空 Map を返す', async () => {
    const queryRaw = vi.fn()
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await loadPromotedTweetCountsForAccounts(prisma, [], since)

    expect(result).toEqual(new Map())
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('account ごとの件数を 1 回の queryRaw で集計し、該当の無い account はキーを持たない', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { accountId: 'u1', count: 2 },
      { accountId: 'u2', count: 1 },
    ])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await loadPromotedTweetCountsForAccounts(prisma, ['u1', 'u2', 'u3'], since)

    expect(queryRaw).toHaveBeenCalledTimes(1)
    const call = queryRaw.mock.calls[0] as [string[], ...unknown[]]
    const sql = call[0].join('?')
    expect(sql).toContain('"isPromoted" = true')
    expect(sql).toContain('"createdAt" >=')
    expect(sql).toContain('GROUP BY "accountId"')
    expect(call.slice(1)).toEqual([['u1', 'u2', 'u3'], since])
    expect(result).toEqual(
      new Map([
        ['u1', 2],
        ['u2', 1],
      ]),
    )
    expect(result.has('u3')).toBe(false)
  })
})
