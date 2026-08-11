import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { LabelRule } from '../labels/types'
import { LabelRuleRegistry } from '../labels/registry'
import { buildDuplicateReplyIndex } from '../labels/duplicate-reply-index'
import { buildReplyHijackIndex } from '../labels/reply-hijack-index'
import { ensureLabelDefinitionsForRules } from './label-repository'
import { getPrismaClient } from './client'
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

function baseTweet(id: string, accountId: string) {
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
    hasAiGeneratedMedia: null as boolean | null,
    aiGeneratedDetectionSource: null as string | null,
    quotedTweetId: null,
    quotedTweetAuthorId: null,
    quotedTweetHasVideo: null,
    source: 'profile' as const,
  }
}

function tweet(
  id: string,
  accountId: string,
  overrides: Partial<ReturnType<typeof baseTweet>> = {},
) {
  return { ...baseTweet(id, accountId), ...overrides }
}

const noFollowGraphSignals = { signalsFor: () => ({}) }

function emptyRegistryParams() {
  return {
    registry: new LabelRuleRegistry(),
    labelDefinitionIds: new Map<string, string>(),
    duplicateReplyIndex: buildDuplicateReplyIndex([]),
    replyHijackIndex: buildReplyHijackIndex([]),
    followGraphLabelIndex: noFollowGraphSignals,
  }
}

describe('persistAuthorResultAtomic', () => {
  it('upserts the fallback author before the context tweet that references it', async () => {
    const calls: string[] = []
    const accountUpsert = vi.fn((args: { where: { id: string } }) => {
      calls.push(`account:${args.where.id}`)
      return Promise.resolve({})
    })
    const accountFindUnique = vi.fn().mockResolvedValue(null)
    const tweetFindUnique = vi.fn().mockResolvedValue(null)
    const tweetUpsert = vi.fn((args: { where: { id: string } }) => {
      calls.push(`tweet:${args.where.id}`)
      return Promise.resolve({ accountId: args.where.id === 'tweet1' ? 'author1' : 'context1' })
    })
    const authorCheckpointUpsert = vi.fn().mockResolvedValue({})
    const queryRaw = vi.fn().mockResolvedValue([])
    const txClient = {
      account: { upsert: accountUpsert, findUnique: accountFindUnique },
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
      additionalOwnTweets: [],
      recentTweetsFallbackAuthors: [profile('author1'), profile('context1')],
      followSample: null,
      ...emptyRegistryParams(),
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(result).toEqual({ observationId: null, labelsAppliedCount: 0 })
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
    const accountFindUnique = vi.fn().mockResolvedValue(null)
    const tweetFindUnique = vi.fn().mockResolvedValue(null)
    const tweetUpsert = vi.fn().mockResolvedValue({ accountId: 'author1' })
    const followSampleDeleteMany = vi.fn()
    const authorCheckpointUpsert = vi.fn().mockResolvedValue({})
    const txClient = {
      account: { upsert: accountUpsert, findUnique: accountFindUnique },
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
      additionalOwnTweets: [],
      recentTweetsFallbackAuthors: [],
      followSample: null,
      ...emptyRegistryParams(),
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
    const followUpsertQueryRaw = vi.fn().mockResolvedValue([{ id: 'followee1' }])
    const followSampleDeleteMany = vi.fn().mockResolvedValue({ count: 0 })
    const followSampleCreateMany = vi.fn().mockResolvedValue({ count: 1 })
    const authorCheckpointUpsert = vi.fn().mockResolvedValue({})
    const txClient = {
      account: { upsert: accountUpsert, findUnique: vi.fn().mockResolvedValue(null) },
      tweet: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ accountId: 'author1' }),
      },
      labelingFollowSample: {
        deleteMany: followSampleDeleteMany,
        createMany: followSampleCreateMany,
      },
      crawlAuthorCheckpoint: { upsert: authorCheckpointUpsert },
      $queryRaw: vi.fn().mockResolvedValue([]),
    }
    const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txClient))
    const prisma = {
      $queryRaw: followUpsertQueryRaw,
      $transaction: transaction,
    } as unknown as PrismaClient

    await persistAuthorResultAtomic(prisma, {
      crawlRunId: 'run1',
      username: 'someuser',
      authorId: 'author1',
      profile: profile('author1'),
      recentTweets: [],
      additionalOwnTweets: [],
      recentTweetsFallbackAuthors: [],
      followSample: { ids: ['followee1'], authors: [profile('followee1')], reachedEnd: true },
      ...emptyRegistryParams(),
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(followUpsertQueryRaw).toHaveBeenCalledTimes(1)
    expect(followSampleDeleteMany).toHaveBeenCalledWith({ where: { accountId: 'author1' } })
    expect(followSampleCreateMany).toHaveBeenCalledWith({
      data: [{ accountId: 'author1', followeeId: 'followee1' }],
      skipDuplicates: true,
    })
  })

  it('opens the transaction with an extended budget for the combined write', async () => {
    const txClient = {
      account: {
        upsert: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      tweet: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ accountId: 'author1' }),
      },
      crawlAuthorCheckpoint: { upsert: vi.fn().mockResolvedValue({}) },
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
      additionalOwnTweets: [],
      recentTweetsFallbackAuthors: [],
      followSample: null,
      ...emptyRegistryParams(),
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 30_000,
      timeout: 30_000,
    })
  })

  it('upserts each fallback author only once even if it appears against multiple context tweets', async () => {
    const accountUpsert = vi.fn().mockResolvedValue({})
    const txClient = {
      account: { upsert: accountUpsert, findUnique: vi.fn().mockResolvedValue(null) },
      tweet: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ accountId: 'context1' }),
      },
      crawlAuthorCheckpoint: { upsert: vi.fn().mockResolvedValue({}) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    }
    const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txClient))
    const prisma = { $transaction: transaction } as unknown as PrismaClient

    await persistAuthorResultAtomic(prisma, {
      crawlRunId: 'run1',
      username: 'someuser',
      authorId: 'author1',
      profile: profile('author1'),
      recentTweets: [tweet('tweet1', 'context1'), tweet('tweet2', 'context1')],
      additionalOwnTweets: [],
      recentTweetsFallbackAuthors: [profile('context1'), profile('context1')],
      followSample: null,
      ...emptyRegistryParams(),
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    // author1 (自分) 用に 1 回 + context1 用に 1 回のみ。重複したままだと 3 回目が呼ばれる。
    expect(accountUpsert).toHaveBeenCalledTimes(2)
  })
})

describe.skipIf(!process.env.DATABASE_URL)(
  'persistAuthorResultAtomic ラベル評価の merge 一致',
  () => {
    const prisma = getPrismaClient()

    beforeEach(async () => {
      // Block は他の統合テストファイルが残す可能性があり、
      // account 削除時の FK 違反を避けるため先に消しておく。
      await prisma.block.deleteMany()
      await prisma.tweet.deleteMany()
      await prisma.accountLabel.deleteMany()
      await prisma.accountLabelLatest.deleteMany()
      await prisma.crawlAuthorCheckpoint.deleteMany()
      await prisma.crawlAccountLabelRun.deleteMany()
      await prisma.crawlRun.deleteMany()
      await prisma.account.deleteMany()
    })

    it('DB に既存の hasAiGeneratedMedia=true がある場合、今回の fetch が null でも評価は true を反映する', async () => {
      const registry = new LabelRuleRegistry()
      const aiRule: LabelRule = {
        key: 'test_ai_media',
        description: 'テスト用の AI メディアルール',
        version: '1.0.0',
        evaluate: (bundle) => ({
          value: bundle.recentTweets.some((t) => t.hasAiGeneratedMedia === true),
          confidence: 1,
          reason: 'test',
        }),
      }
      registry.register(aiRule)
      const labelDefinitionIds = await ensureLabelDefinitionsForRules(prisma, registry.getAll())
      const crawlRunOne = await prisma.crawlRun.create({
        data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
      })
      const crawlRunTwo = await prisma.crawlRun.create({
        data: { startedAt: new Date(), lastHeartbeatAt: new Date(), status: 'running' },
      })

      const authorProfile = profile('acct-1')
      // 1 周目: AI メディアが検出された状態で保存する。
      await persistAuthorResultAtomic(prisma, {
        crawlRunId: crawlRunOne.id,
        username: 'tester',
        authorId: 'acct-1',
        profile: authorProfile,
        recentTweets: [
          tweet('t1', 'acct-1', {
            hasAiGeneratedMedia: true,
            aiGeneratedDetectionSource: 'C2paClient',
          }),
        ],
        additionalOwnTweets: [],
        recentTweetsFallbackAuthors: [],
        followSample: null,
        registry,
        labelDefinitionIds,
        duplicateReplyIndex: buildDuplicateReplyIndex([]),
        replyHijackIndex: buildReplyHijackIndex([]),
        followGraphLabelIndex: noFollowGraphSignals,
        warnings: [],
        durationMs: 0,
        retryWaitMs: 0,
        appVersion: 'test',
      })

      // 2 周目: 今回の fetch では AI メディア情報が取れず null になったが、
      // DB 側は merge により true を保持しているはずなので、評価も true のままになる。
      await persistAuthorResultAtomic(prisma, {
        crawlRunId: crawlRunTwo.id,
        username: 'tester',
        authorId: 'acct-1',
        profile: authorProfile,
        recentTweets: [tweet('t1', 'acct-1', { hasAiGeneratedMedia: null })],
        additionalOwnTweets: [],
        recentTweetsFallbackAuthors: [],
        followSample: null,
        registry,
        labelDefinitionIds,
        duplicateReplyIndex: buildDuplicateReplyIndex([]),
        replyHijackIndex: buildReplyHijackIndex([]),
        followGraphLabelIndex: noFollowGraphSignals,
        warnings: [],
        durationMs: 0,
        retryWaitMs: 0,
        appVersion: 'test',
      })

      const latest = await prisma.accountLabelLatest.findUniqueOrThrow({
        where: {
          accountId_labelDefinitionId: {
            accountId: 'acct-1',
            labelDefinitionId: labelDefinitionIds.get('test_ai_media') ?? '',
          },
        },
      })
      expect(latest.value).toBe(true)
    })
  },
)
