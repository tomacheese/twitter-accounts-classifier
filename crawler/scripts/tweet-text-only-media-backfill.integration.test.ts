import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPrismaClient } from '../db/client'
import { runTextOnlyMediaBackfill } from './tweet-text-only-media-backfill'

describe.skipIf(!process.env.DATABASE_URL)('runTextOnlyMediaBackfill (integration)', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.tweet.deleteMany()
  })

  it('複数アカウントにまたがる Tweet を (accountId, id) の順に漏れなく走査して更新する', async () => {
    // accountId の並びと id の並びが一致しないように並べる。
    const tweets = [
      { accountId: '5000002', id: '4000001' },
      { accountId: '5000001', id: '4000002' },
      { accountId: '5000003', id: '4000003' },
      { accountId: '5000001', id: '4000004' },
      { accountId: '5000002', id: '4000005' },
    ]
    for (const tweet of tweets) {
      await prisma.tweet.create({
        data: {
          ...tweet,
          fullText: 'synthetic text-only post',
          createdAt: new Date('2026-10-01T00:00:00Z'),
          collectedAt: new Date('2026-10-01T00:00:00Z'),
          retweetCount: 0,
          likeCount: 0,
          replyCount: 0,
        },
      })
    }
    const logs: string[] = []

    await runTextOnlyMediaBackfill(
      {
        foreignVideoSince: new Date('2026-08-03T00:00:00Z'),
        hasMediaSince: new Date('2026-09-28T00:00:00Z'),
        batchSize: 2,
        sleepMs: 0,
        execute: true,
      },
      { prisma, sleep: vi.fn().mockResolvedValue(undefined), log: (message) => logs.push(message) },
    )

    const rows = await prisma.tweet.findMany({
      select: { foreignVideoSourceCount: true, hasMedia: true },
    })
    expect(rows).toHaveLength(5)
    expect(rows.every((row) => row.foreignVideoSourceCount === 0 && row.hasMedia === false)).toBe(
      true,
    )
    expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({
      mode: 'execute',
      scanned: 5,
      updated: 5,
      lastKey: '5000003:4000003',
    })
  })
})
