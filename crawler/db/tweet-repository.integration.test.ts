import { beforeEach, describe, expect, it } from 'vitest'
import { Prisma } from '../generated/prisma'
import { getPrismaClient } from './client'
import {
  findMissingTweetIds,
  findTweet,
  findTweetContextsByIds,
  loadRecentTweetsForAccounts,
  recentTweetsQuery,
  upsertTweet,
  type TweetInput,
} from './tweet-repository'

function makeTweet(id: string, accountId: string, overrides: Partial<TweetInput> = {}): TweetInput {
  return {
    id,
    accountId,
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
    hasAiGeneratedMedia: null,
    aiGeneratedDetectionSource: null,
    foreignVideoSourceCount: null,
    quotedTweetId: null,
    quotedTweetAuthorId: null,
    quotedTweetHasVideo: null,
    source: 'recommended',
    ...overrides,
  }
}

const prisma = getPrismaClient()

async function rowVersion(accountId: string, id: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ xmin: string }[]>`
    SELECT xmin::text AS "xmin" FROM "Tweet" WHERE "accountId" = ${accountId}::bigint AND "id" = ${id}::bigint
  `
  return rows[0].xmin
}

async function seedForExplain(): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "Tweet" ("id", "accountId", "createdAt", "collectedAt", "retweetCount", "likeCount", "replyCount", "isReply", "fullText")
    SELECT 1100000 + g, 3000000 + (g % 100), now() - (g || ' seconds')::interval,
           now() - (g || ' seconds')::interval, 0, 0, 0, (g % 3 = 0), 'fiction ' || g
    FROM generate_series(1, 6000) g
  `
  await prisma.$executeRaw`ANALYZE "Tweet"`
}

async function explain(query: Prisma.Sql): Promise<string[]> {
  // 小さな表ではプランナが Seq Scan を選びうるため、索引を使える形になっていることだけを検査する。
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`
    const rows = await tx.$queryRaw<{ 'QUERY PLAN': string }[]>(
      Prisma.sql`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${query}`,
    )
    return rows.map((row) => row['QUERY PLAN'])
  })
}

describe.skipIf(!process.env.DATABASE_URL)('tweet-repository (integration)', () => {
  beforeEach(async () => {
    await prisma.tweet.deleteMany()
  })

  describe('upsertTweet', () => {
    it('空配列の URL 列は NULL で保存し、読み出しでは空配列として扱う', async () => {
      const { tweet } = await upsertTweet(prisma, makeTweet('1000001', '2000001'))

      const [raw] = await prisma.$queryRaw<{ expandedUrlsIsNull: boolean; cardIsNull: boolean }[]>`
        SELECT "expandedUrls" IS NULL AS "expandedUrlsIsNull", "cardDestinationUrls" IS NULL AS "cardIsNull"
        FROM "Tweet" WHERE "id" = 1000001
      `
      expect(raw).toEqual({ expandedUrlsIsNull: true, cardIsNull: true })
      expect(tweet.expandedUrls).toEqual([])
      expect(tweet.cardDestinationUrls).toEqual([])
      const reloaded = await findTweet(prisma, '2000001', '1000001')
      expect(reloaded?.expandedUrls).toEqual([])
    })

    it('19 桁の ID を桁落ちなく往復する', async () => {
      const id = '1900000000000000001'
      const accountId = '1900000000000000002'

      await upsertTweet(
        prisma,
        makeTweet(id, accountId, { inReplyToTweetId: '1900000000000000003' }),
      )

      const reloaded = await findTweet(prisma, accountId, id)
      expect(reloaded).toMatchObject({ id, accountId, inReplyToTweetId: '1900000000000000003' })
    })

    it('同じ値の再 upsert は行を書き換えず、changed は false になる', async () => {
      const input = makeTweet('1000001', '2000001', { expandedUrls: ['https://example.com/a'] })
      await upsertTweet(prisma, input)
      const before = await rowVersion('2000001', '1000001')

      const second = await upsertTweet(prisma, input)

      expect(second.changed).toBe(false)
      expect(second.tweet.expandedUrls).toEqual(['https://example.com/a'])
      expect(await rowVersion('2000001', '1000001')).toBe(before)
    })

    it('URL の並びだけが違う再取得でも行を書き換えない', async () => {
      await upsertTweet(
        prisma,
        makeTweet('1000001', '2000001', {
          expandedUrls: ['https://example.com/a', 'https://example.com/b'],
        }),
      )
      const before = await rowVersion('2000001', '1000001')

      const second = await upsertTweet(
        prisma,
        makeTweet('1000001', '2000001', {
          expandedUrls: ['https://example.com/b', 'https://example.com/a'],
        }),
      )

      expect(second.changed).toBe(false)
      expect(await rowVersion('2000001', '1000001')).toBe(before)
    })

    it('値が変わると更新し、ラベル評価に影響する変化なら changed は true になる', async () => {
      await upsertTweet(prisma, makeTweet('1000001', '2000001'))
      const before = await rowVersion('2000001', '1000001')

      const second = await upsertTweet(prisma, makeTweet('1000001', '2000001', { likeCount: 11 }))

      expect(second.changed).toBe(true)
      expect(second.tweet.likeCount).toBe(11)
      expect(await rowVersion('2000001', '1000001')).not.toBe(before)
    })

    it('ラベル評価に影響しない列 (replyCount) だけの変化も書き込み、changed は false のままにする', async () => {
      await upsertTweet(prisma, makeTweet('1000001', '2000001'))

      const second = await upsertTweet(prisma, makeTweet('1000001', '2000001', { replyCount: 9 }))

      expect(second.changed).toBe(false)
      expect(second.tweet.replyCount).toBe(9)
      const reloaded = await findTweet(prisma, '2000001', '1000001')
      expect(reloaded?.replyCount).toBe(9)
    })

    it('既存行の isAuthorReply と collectedAt は再取得で変えない', async () => {
      const first = await upsertTweet(
        prisma,
        makeTweet('1000001', '2000001', { isAuthorReply: true }),
      )

      const second = await upsertTweet(
        prisma,
        makeTweet('1000001', '2000001', { isAuthorReply: false, likeCount: 99 }),
      )

      expect(second.tweet.isAuthorReply).toBe(true)
      expect(second.tweet.collectedAt).toEqual(first.tweet.collectedAt)
    })

    it('広告フラグと既知の URL を再取得で失わない', async () => {
      await upsertTweet(
        prisma,
        makeTweet('1000001', '2000001', {
          isPromoted: true,
          cardDestinationUrls: ['https://example-shop.test/item/FICTIONAL'],
          cardDestinationUrlsEvaluated: true,
        }),
      )

      const { tweet } = await upsertTweet(
        prisma,
        makeTweet('1000001', '2000001', { isPromoted: false, cardDestinationUrlsEvaluated: false }),
      )

      expect(tweet.isPromoted).toBe(true)
      expect(tweet.cardDestinationUrls).toEqual(['https://example-shop.test/item/FICTIONAL'])
      expect(tweet.cardDestinationUrlsEvaluated).toBe(true)
    })

    it('Tweet が Account を参照しなくても保存できる (FK なし)', async () => {
      await prisma.account.deleteMany({ where: { id: '2999999' } })

      await upsertTweet(prisma, makeTweet('1000001', '2999999'))

      expect(await findTweet(prisma, '2999999', '1000001')).not.toBeNull()
    })
  })

  describe('ID 単独の検索', () => {
    it('複数パーティションにまたがる Tweet を、投稿者を指定せずに引ける', async () => {
      const accountIds = Array.from({ length: 40 }, (_, index) => String(2_000_100 + index))
      for (const [index, accountId] of accountIds.entries()) {
        await upsertTweet(
          prisma,
          makeTweet(String(1_000_100 + index), accountId, { fullText: `本文 ${index}` }),
        )
      }
      const [{ partitions }] = await prisma.$queryRaw<{ partitions: number }[]>`
        SELECT count(DISTINCT tableoid)::int AS "partitions" FROM "Tweet"
      `
      expect(partitions).toBeGreaterThan(1)

      const missing = await findMissingTweetIds(prisma, ['1000100', '1000139', '1999999'])
      const contexts = await findTweetContextsByIds(prisma, ['1000100', '1000139', '1999999'])

      expect(missing).toEqual(['1999999'])
      expect([...contexts.keys()].toSorted()).toEqual(['1000100', '1000139'])
      expect(contexts.get('1000139')).toEqual({ fullText: '本文 39', accountId: '2000139' })
    })
  })

  describe('loadRecentTweetsForAccounts', () => {
    it('account ごとに作成日時の新しい順で上限件数だけ返し、NULL の URL 列は空配列にする', async () => {
      for (let index = 0; index < 25; index++) {
        await upsertTweet(
          prisma,
          makeTweet(String(1_000_200 + index), '2000201', {
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
          }),
        )
      }
      await upsertTweet(prisma, makeTweet('1000300', '2000202'))

      const result = await loadRecentTweetsForAccounts(
        prisma,
        ['2000201', '2000202', '2000203'],
        20,
      )

      const recent = result.get('2000201') ?? []
      expect(recent).toHaveLength(20)
      expect(recent[0].id).toBe('1000224')
      expect(recent.at(-1)?.id).toBe('1000205')
      expect(recent[0].expandedUrls).toEqual([])
      expect(result.get('2000202')?.map((t) => t.id)).toEqual(['1000300'])
      expect(result.has('2000203')).toBe(false)
    })
  })

  describe('実行計画', () => {
    it('直近 20 件の取得は 1 つのパーティションだけを accountId の索引で走査する', async () => {
      await seedForExplain()

      const plan = await explain(recentTweetsQuery(['3000007'], 20))

      const executed = plan.filter(
        (line) => line.includes('Index Scan Backward') && !line.includes('never executed'),
      )
      expect(executed).toHaveLength(1)
      expect(executed[0]).toMatch(/Tweet_h\d\d_accountId_createdAt_idx/)
      expect(
        plan.some((line) => line.includes('Seq Scan') && !line.includes('never executed')),
      ).toBe(false)
    })

    it('reply corpus の取得は isReply の部分インデックスを使う', async () => {
      await seedForExplain()

      // reply-corpus.ts の findMany が発行する文と同じ条件と並び順。
      const plan = await explain(Prisma.sql`
        SELECT "id", "accountId", "fullText", "inReplyToTweetId", "createdAt" FROM "Tweet"
        WHERE "isReply" = true AND "collectedAt" <= now()
        ORDER BY "collectedAt" DESC, "id" DESC LIMIT 20000
      `)

      expect(
        plan.some((line) => /Index Scan using "Tweet_h\d\d_collectedAt_id_idx"/.test(line)),
      ).toBe(true)
      expect(plan.some((line) => line.includes('Seq Scan'))).toBe(false)
    })
  })
})
