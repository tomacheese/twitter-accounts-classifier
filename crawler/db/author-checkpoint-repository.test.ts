import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { persistAuthorResultAtomic } from './author-checkpoint-repository'

function profile(id: string) {
  return {
    id,
    screenName: `user_${id}`,
    displayName: `User ${id}`,
    bio: null,
    profileImageUrl: null,
    followersCount: 0,
    followingCount: 0,
    tweetCount: 0,
    accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
    location: null,
    url: null,
    isBlueVerified: false,
    verifiedType: null,
    professionalType: null,
    parodyCommentaryFanLabel: null,
  }
}

function tweet(id: string, accountId: string) {
  return {
    id,
    accountId,
    fullText: 'hello',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    retweetCount: 0,
    likeCount: 0,
    replyCount: 0,
    quoteCount: 0,
    isReply: false,
    inReplyToTweetId: null,
    isAuthorReply: false,
    isRetweet: false,
    retweetedTweetId: null,
    isPromoted: false,
    isPaidPromotion: false,
    hasAiGeneratedMedia: null,
    aiGeneratedDetectionSource: null,
    quotedTweetId: null,
    quotedTweetAuthorId: null,
    quotedTweetHasVideo: null,
    source: 'profile' as const,
  }
}

describe('persistAuthorResultAtomic', () => {
  it('upserts the fallback author before the context tweet that references it', async () => {
    const calls: string[] = []
    const accountUpsert = vi.fn((args: { where: { id: string } }) => {
      calls.push(`account:${args.where.id}`)
      return Promise.resolve({})
    })
    const tweetFindUnique = vi.fn().mockResolvedValue(null)
    const tweetUpsert = vi.fn((args: { where: { id: string } }) => {
      calls.push(`tweet:${args.where.id}`)
      return Promise.resolve({})
    })
    const authorCheckpointUpsert = vi.fn().mockResolvedValue({})
    const queryRaw = vi.fn().mockResolvedValue([])
    const txClient = {
      account: { upsert: accountUpsert },
      tweet: { findUnique: tweetFindUnique, upsert: tweetUpsert },
      crawlAuthorCheckpoint: { upsert: authorCheckpointUpsert },
      $queryRaw: queryRaw,
    }
    const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txClient))
    const prisma = { $transaction: transaction } as unknown as PrismaClient

    const result = await persistAuthorResultAtomic(prisma, {
      crawlRunId: 'run1',
      username: 'someuser',
      authorId: 'author1',
      profile: profile('author1'),
      recentTweets: [tweet('tweet1', 'author1'), tweet('tweet2', 'context1')],
      recentTweetsFallbackAuthors: [profile('author1'), profile('context1')],
      followSample: null,
      labels: [],
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(result).toEqual({ observationId: null })
    expect(calls.indexOf('account:context1')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('account:context1')).toBeLessThan(calls.indexOf('tweet:tweet2'))
    expect(accountUpsert).toHaveBeenCalledTimes(2)
    expect(authorCheckpointUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          authorId: 'author1',
          status: 'success',
          profileCount: 1,
        }),
      }),
    )
  })

  it('skips the labeling follow sample write when followSample is null, without failing the transaction', async () => {
    const accountUpsert = vi.fn().mockResolvedValue({})
    const tweetFindUnique = vi.fn().mockResolvedValue(null)
    const tweetUpsert = vi.fn().mockResolvedValue({})
    const followSampleDeleteMany = vi.fn()
    const authorCheckpointUpsert = vi.fn().mockResolvedValue({})
    const txClient = {
      account: { upsert: accountUpsert },
      tweet: { findUnique: tweetFindUnique, upsert: tweetUpsert },
      labelingFollowSample: { deleteMany: followSampleDeleteMany },
      crawlAuthorCheckpoint: { upsert: authorCheckpointUpsert },
      $queryRaw: vi.fn().mockResolvedValue([]),
    }
    const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txClient))
    const prisma = { $transaction: transaction } as unknown as PrismaClient

    await persistAuthorResultAtomic(prisma, {
      crawlRunId: 'run1',
      username: 'someuser',
      authorId: 'author1',
      profile: profile('author1'),
      recentTweets: [],
      recentTweetsFallbackAuthors: [],
      followSample: null,
      labels: [],
      warnings: [
        {
          type: 'labeling_follow_sample_failed',
          message: 'm',
          authorId: 'author1',
          errorMessage: 'e',
        },
      ],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(followSampleDeleteMany).not.toHaveBeenCalled()
    expect(authorCheckpointUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'success' }),
      }),
    )
  })

  it('replaces the labeling follow sample within the same transaction when followSample is provided', async () => {
    const accountUpsert = vi.fn().mockResolvedValue({})
    const followUpsertedAccountUpsert = vi.fn().mockResolvedValue({})
    const followSampleDeleteMany = vi.fn().mockResolvedValue({ count: 0 })
    const followSampleCreateMany = vi.fn().mockResolvedValue({ count: 1 })
    const authorCheckpointUpsert = vi.fn().mockResolvedValue({})
    const txClient = {
      account: { upsert: accountUpsert },
      tweet: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
      labelingFollowSample: {
        deleteMany: followSampleDeleteMany,
        createMany: followSampleCreateMany,
      },
      crawlAuthorCheckpoint: { upsert: authorCheckpointUpsert },
      $queryRaw: vi.fn().mockResolvedValue([]),
    }
    const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txClient))
    const prisma = {
      account: { upsert: followUpsertedAccountUpsert },
      $transaction: transaction,
    } as unknown as PrismaClient

    await persistAuthorResultAtomic(prisma, {
      crawlRunId: 'run1',
      username: 'someuser',
      authorId: 'author1',
      profile: profile('author1'),
      recentTweets: [],
      recentTweetsFallbackAuthors: [],
      followSample: { ids: ['followee1'], authors: [profile('followee1')], reachedEnd: true },
      labels: [],
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(followUpsertedAccountUpsert).toHaveBeenCalledTimes(1)
    expect(followSampleDeleteMany).toHaveBeenCalledWith({ where: { accountId: 'author1' } })
    expect(followSampleCreateMany).toHaveBeenCalledWith({
      data: [{ accountId: 'author1', followeeId: 'followee1' }],
      skipDuplicates: true,
    })
  })
})
