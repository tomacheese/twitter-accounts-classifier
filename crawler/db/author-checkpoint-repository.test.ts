import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { AccountFeatureBundle, LabelRule } from '../labels/types'
import { LabelRuleRegistry } from '../labels/registry'
import { buildDuplicateReplyIndex } from '../labels/duplicate-reply-index'
import { buildBioDuplicateIndex } from '../labels/bio-duplicate-index'
import { buildReplyHijackIndex } from '../labels/reply-hijack-index'
import { buildSelfReplyPromoIndex } from '../labels/self-reply-promo-index'
import { replyHijackSwarmRule } from '../labels/rules/reply-hijack-swarm'
import { ensureLabelDefinitionsForRules } from './label-repository'
import * as labelRepository from './label-repository'
import * as evidenceRepository from './reply-hijack-evidence-repository'
import * as workItemRepository from './analysis-work-item-repository'
import { getPrismaClient } from './client'
import { persistAuthorResultAtomic } from './author-checkpoint-repository'

function profile(id: string, overrides: Partial<{ bio: string | null }> = {}) {
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
    ...overrides,
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
    inReplyToTweetId: null as string | null,
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
    bioDuplicateIndex: buildBioDuplicateIndex([]),
    replyHijackIndex: buildReplyHijackIndex([]),
    followGraphLabelIndex: noFollowGraphSignals,
    selfReplyPromoIndex: buildSelfReplyPromoIndex([], []),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('persistAuthorResultAtomic', () => {
  it('persists positive reply-hijack evidence in the author transaction using the deterministic target tie-break', async () => {
    const registry = new LabelRuleRegistry()
    registry.register(replyHijackSwarmRule)
    const evidenceSpy = vi
      .spyOn(evidenceRepository, 'upsertReplyHijackEvidence')
      .mockResolvedValue()
    vi.spyOn(labelRepository, 'recordCrawlAccountLabelsAtomicWithinTx').mockResolvedValue(
      'observation-1',
    )
    const authorProfile = profile('author1')
    const txClient = {
      account: {
        upsert: vi.fn().mockResolvedValue(authorProfile),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ ...authorProfile, recentTweetsFetchStatus: 'success' }),
      },
      tweet: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn(({ create }: { create: ReturnType<typeof baseTweet> }) =>
          Promise.resolve({
            ...create,
            expandedUrls: [],
            foreignVideoSourceCount: null,
            collectedAt: new Date('2026-01-01T00:00:00Z'),
          }),
        ),
      },
      crawlAuthorCheckpoint: { upsert: vi.fn().mockResolvedValue({}) },
    }
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txClient)),
    } as unknown as PrismaClient
    const evidenceByTarget = {
      'target-b': {
        targetTweetId: 'target-b',
        swarmSize: 5,
        averageSimilarity: 0.8,
        spanHours: 3,
        replyTweetIds: ['reply-b-1'],
      },
      'target-a': {
        targetTweetId: 'target-a',
        swarmSize: 5,
        averageSimilarity: 0.9,
        spanHours: 2,
        replyTweetIds: ['reply-a-1'],
      },
    }

    await persistAuthorResultAtomic(prisma, {
      crawlRunId: 'run1',
      username: 'someuser',
      authorId: 'author1',
      profile: authorProfile,
      recentTweets: [
        tweet('reply-b-1', 'author1', { isReply: true, inReplyToTweetId: 'target-b' }),
        tweet('reply-a-1', 'author1', { isReply: true, inReplyToTweetId: 'target-a' }),
        tweet('post-1', 'author1'),
      ],
      additionalOwnTweets: [],
      recentTweetsFallbackAuthors: [],
      followSample: null,
      registry,
      labelDefinitionIds: new Map([['reply_hijack_swarm', 'def-1']]),
      duplicateReplyIndex: buildDuplicateReplyIndex([]),
      bioDuplicateIndex: buildBioDuplicateIndex([]),
      replyHijackIndex: {
        swarmSizeFor: () => 5,
        isEligibleForScreening: () => true,
        evidenceFor: (_accountId, targetTweetId) =>
          evidenceByTarget[targetTweetId as keyof typeof evidenceByTarget],
      },
      followGraphLabelIndex: noFollowGraphSignals,
      selfReplyPromoIndex: buildSelfReplyPromoIndex([], []),
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(evidenceSpy).toHaveBeenCalledWith(txClient, {
      accountId: 'author1',
      targetTweetId: 'target-a',
      ruleVersion: replyHijackSwarmRule.version,
      swarmSize: 5,
      averageSimilarity: 0.9,
      spanHours: 2,
      replyTweetIds: ['reply-a-1'],
    })
  })

  it.each([
    { name: 'the reply-ratio guard rejects the account', claimedObservationId: 'observation-1' },
    { name: 'the crawl label claim is already taken', claimedObservationId: null },
  ])('does not persist reply-hijack evidence when $name', async ({ claimedObservationId }) => {
    const registry = new LabelRuleRegistry()
    registry.register(replyHijackSwarmRule)
    const evidenceSpy = vi
      .spyOn(evidenceRepository, 'upsertReplyHijackEvidence')
      .mockResolvedValue()
    vi.spyOn(labelRepository, 'recordCrawlAccountLabelsAtomicWithinTx').mockResolvedValue(
      claimedObservationId,
    )
    const authorProfile = profile('author1')
    const txClient = {
      account: {
        upsert: vi.fn().mockResolvedValue(authorProfile),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ ...authorProfile, recentTweetsFetchStatus: 'success' }),
      },
      tweet: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn(({ create }: { create: ReturnType<typeof baseTweet> }) =>
          Promise.resolve({
            ...create,
            expandedUrls: [],
            foreignVideoSourceCount: null,
            collectedAt: new Date('2026-01-01T00:00:00Z'),
          }),
        ),
      },
      crawlAuthorCheckpoint: { upsert: vi.fn().mockResolvedValue({}) },
    }
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txClient)),
    } as unknown as PrismaClient
    const recentTweets =
      claimedObservationId === null
        ? [
            tweet('reply-1', 'author1', { isReply: true, inReplyToTweetId: 'target-1' }),
            tweet('reply-2', 'author1', { isReply: true, inReplyToTweetId: 'target-1' }),
            tweet('post-1', 'author1'),
          ]
        : [
            tweet('reply-1', 'author1', { isReply: true, inReplyToTweetId: 'target-1' }),
            tweet('post-1', 'author1'),
            tweet('post-2', 'author1'),
          ]

    await persistAuthorResultAtomic(prisma, {
      crawlRunId: 'run1',
      username: 'someuser',
      authorId: 'author1',
      profile: authorProfile,
      recentTweets,
      additionalOwnTweets: [],
      recentTweetsFallbackAuthors: [],
      followSample: null,
      registry,
      labelDefinitionIds: new Map([['reply_hijack_swarm', 'def-1']]),
      duplicateReplyIndex: buildDuplicateReplyIndex([]),
      bioDuplicateIndex: buildBioDuplicateIndex([]),
      replyHijackIndex: {
        swarmSizeFor: () => 5,
        isEligibleForScreening: () => true,
        evidenceFor: () => ({
          targetTweetId: 'target-1',
          swarmSize: 5,
          averageSimilarity: 0.8,
          spanHours: 3,
          replyTweetIds: ['reply-1'],
        }),
      },
      followGraphLabelIndex: noFollowGraphSignals,
      selfReplyPromoIndex: buildSelfReplyPromoIndex([], []),
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(evidenceSpy).not.toHaveBeenCalled()
  })

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
      account: {
        upsert: accountUpsert,
        findUnique: accountFindUnique,
        update: vi.fn().mockResolvedValue({ id: 'author1' }),
      },
      tweet: { findUnique: tweetFindUnique, upsert: tweetUpsert },
      accountLabelLatest: { findMany: vi.fn().mockResolvedValue([]) },
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
      parentTweetFetchRequestCount: 1,
      parentTweetFetchRateLimitRemaining: 5,
      parentTweetFetchRateLimitReset: 1_760_000_000,
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
          parentTweetFetchRequestCount: 1,
          parentTweetFetchRateLimitRemaining: 5,
          parentTweetFetchRateLimitReset: 1_760_000_000,
        }),
      }),
    )
  })

  it('resolves parentTweetFullText from a context tweet belonging to another account', async () => {
    let capturedBundle: AccountFeatureBundle | undefined
    const rule: LabelRule = {
      key: 'capture_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: (bundle) => {
        capturedBundle = bundle
        return { value: false, confidence: 0.5, reason: 'test' }
      },
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    const tweetUpsert = vi.fn((args: { where: { id: string } }) => {
      if (args.where.id === 'tweet1') {
        return Promise.resolve({
          id: 'tweet1',
          accountId: 'author1',
          fullText: 'reply text',
          inReplyToTweetId: 'parent1',
        })
      }
      return Promise.resolve({
        id: 'parent1',
        accountId: 'context1',
        fullText: '親ツイートの本文です',
      })
    })
    const txClient = {
      account: {
        upsert: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ id: 'author1' }),
      },
      tweet: { findUnique: vi.fn().mockResolvedValue(null), upsert: tweetUpsert },
      accountLabelLatest: { findMany: vi.fn().mockResolvedValue([]) },
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
      recentTweets: [
        tweet('tweet1', 'author1', { isReply: true, inReplyToTweetId: 'parent1' }),
        tweet('parent1', 'context1'),
      ],
      additionalOwnTweets: [],
      recentTweetsFallbackAuthors: [profile('author1'), profile('context1')],
      followSample: null,
      registry,
      labelDefinitionIds: new Map([['capture_rule', 'def-1']]),
      duplicateReplyIndex: buildDuplicateReplyIndex([]),
      bioDuplicateIndex: buildBioDuplicateIndex([]),
      replyHijackIndex: buildReplyHijackIndex([]),
      followGraphLabelIndex: noFollowGraphSignals,
      selfReplyPromoIndex: buildSelfReplyPromoIndex([], []),
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(capturedBundle?.recentTweets[0].parentTweetFullText).toBe('親ツイートの本文です')
  })

  it('resolves parentTweetFullText via DB lookup when the parent was not fetched this run', async () => {
    let capturedBundle: AccountFeatureBundle | undefined
    const rule: LabelRule = {
      key: 'capture_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: (bundle) => {
        capturedBundle = bundle
        return { value: false, confidence: 0.5, reason: 'test' }
      },
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    // 今回の crawl では reply1 だけが fetch され、parent1 は既に DB にある扱いのため recentTweets に含まれない。
    const tweetUpsert = vi.fn((args: { where: { id: string } }) =>
      Promise.resolve({
        id: args.where.id,
        accountId: 'author1',
        fullText: 'reply text',
        inReplyToTweetId: 'parent1',
      }),
    )
    const tweetFindMany = vi
      .fn()
      .mockResolvedValue([{ id: 'parent1', fullText: '既に DB にある親ツイートの本文です' }])
    const txClient = {
      account: {
        upsert: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ id: 'author1' }),
      },
      tweet: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: tweetUpsert,
        findMany: tweetFindMany,
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
      recentTweets: [tweet('reply1', 'author1', { isReply: true, inReplyToTweetId: 'parent1' })],
      additionalOwnTweets: [],
      recentTweetsFallbackAuthors: [profile('author1')],
      followSample: null,
      registry,
      labelDefinitionIds: new Map([['capture_rule', 'def-1']]),
      duplicateReplyIndex: buildDuplicateReplyIndex([]),
      bioDuplicateIndex: buildBioDuplicateIndex([]),
      replyHijackIndex: buildReplyHijackIndex([]),
      followGraphLabelIndex: noFollowGraphSignals,
      selfReplyPromoIndex: buildSelfReplyPromoIndex([], []),
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(tweetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['parent1'] } } }),
    )
    expect(capturedBundle?.recentTweets[0].parentTweetFullText).toBe(
      '既に DB にある親ツイートの本文です',
    )
  })

  it('passes the post-update recentTweetsFetchStatus to label evaluation within the same cycle', async () => {
    let capturedBundle: AccountFeatureBundle | undefined
    const rule: LabelRule = {
      key: 'capture_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: (bundle) => {
        capturedBundle = bundle
        return { value: false, confidence: 0.5, reason: 'test' }
      },
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    // upsertAccount 直後の戻り値は今回の fetch 前の状態(未取得)を表し、
    // 直後の update で 'success' に変わることを再現する。
    const accountUpsert = vi.fn().mockResolvedValue({
      id: 'author1',
      recentTweetsFetchStatus: null,
    })
    const accountUpdate = vi.fn().mockResolvedValue({
      id: 'author1',
      recentTweetsFetchStatus: 'success',
    })
    const txClient = {
      account: {
        upsert: accountUpsert,
        findUnique: vi.fn().mockResolvedValue(null),
        update: accountUpdate,
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
      registry,
      labelDefinitionIds: new Map([['capture_rule', 'def-1']]),
      duplicateReplyIndex: buildDuplicateReplyIndex([]),
      bioDuplicateIndex: buildBioDuplicateIndex([]),
      replyHijackIndex: buildReplyHijackIndex([]),
      followGraphLabelIndex: noFollowGraphSignals,
      selfReplyPromoIndex: buildSelfReplyPromoIndex([], []),
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(capturedBundle?.account.recentTweetsFetchStatus).toBe('success')
  })

  it('skips the labeling follow sample write when followSample is null, without failing the transaction', async () => {
    const accountUpsert = vi.fn().mockResolvedValue({})
    const accountFindUnique = vi.fn().mockResolvedValue(null)
    const tweetFindUnique = vi.fn().mockResolvedValue(null)
    const tweetUpsert = vi.fn().mockResolvedValue({ accountId: 'author1' })
    const followSampleDeleteMany = vi.fn()
    const authorCheckpointUpsert = vi.fn().mockResolvedValue({})
    const txClient = {
      account: {
        upsert: accountUpsert,
        findUnique: accountFindUnique,
        update: vi.fn().mockResolvedValue({ id: 'author1' }),
      },
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
      account: {
        upsert: accountUpsert,
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ id: 'author1' }),
      },
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
        update: vi.fn().mockResolvedValue({ id: 'author1' }),
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
      account: {
        upsert: accountUpsert,
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ id: 'author1' }),
      },
      tweet: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ accountId: 'context1' }),
      },
      accountLabelLatest: { findMany: vi.fn().mockResolvedValue([]) },
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

  it('fallback author のラベル評価に影響するフィールドが変化していて既存ラベルがあれば account_relabel を要求する', async () => {
    const requestRelabelSpy = vi
      .spyOn(workItemRepository, 'requestAccountRelabel')
      .mockResolvedValue()
    const txClient = {
      account: {
        upsert: vi.fn((args: { where: { id: string } }) => Promise.resolve({ id: args.where.id })),
        // fallback author (context1) の変化検知用。bio 以外は入力と一致させ、
        // bio の変化だけを検知させる。
        findUnique: vi.fn().mockResolvedValue({
          screenName: 'user_context1',
          displayName: 'User context1',
          bio: 'old bio',
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          isBlueVerified: false,
          verifiedType: null,
          professionalType: null,
          parodyCommentaryFanLabel: null,
        }),
        update: vi.fn().mockResolvedValue({ id: 'author1' }),
      },
      tweet: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ accountId: 'context1' }),
      },
      accountLabelLatest: { findMany: vi.fn().mockResolvedValue([{ accountId: 'context1' }]) },
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
      recentTweets: [tweet('tweet1', 'context1')],
      additionalOwnTweets: [],
      recentTweetsFallbackAuthors: [profile('context1', { bio: 'freshly changed bio' })],
      followSample: null,
      ...emptyRegistryParams(),
      warnings: [],
      durationMs: 10,
      retryWaitMs: 0,
      appVersion: 'test',
    })

    expect(requestRelabelSpy).toHaveBeenCalledWith(txClient, 'context1')
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
        bioDuplicateIndex: buildBioDuplicateIndex([]),
        replyHijackIndex: buildReplyHijackIndex([]),
        followGraphLabelIndex: noFollowGraphSignals,
        selfReplyPromoIndex: buildSelfReplyPromoIndex([], []),
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
        bioDuplicateIndex: buildBioDuplicateIndex([]),
        replyHijackIndex: buildReplyHijackIndex([]),
        followGraphLabelIndex: noFollowGraphSignals,
        selfReplyPromoIndex: buildSelfReplyPromoIndex([], []),
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

it('crawl-time label evaluation receives the resolved parent author id', async () => {
  let observedParentAuthorId: string | null | undefined
  const probeRule: LabelRule = {
    key: 'parent_author_probe',
    version: '1.0.0',
    description: 'test probe',
    evaluate(bundle: AccountFeatureBundle) {
      observedParentAuthorId = bundle.recentTweets[0]?.parentTweetAuthorId
      return { value: false, confidence: 1, reason: 'probe' }
    },
  }
  const registry = new LabelRuleRegistry()
  registry.register(probeRule)
  vi.spyOn(labelRepository, 'recordCrawlAccountLabelsAtomicWithinTx').mockResolvedValue(
    'observation-1',
  )
  const authorProfile = profile('author1')
  const upsertedReply = {
    ...tweet('reply-1', 'author1', { isReply: true, inReplyToTweetId: 'parent-1' }),
    expandedUrls: [],
    foreignVideoSourceCount: null,
    collectedAt: new Date('2026-08-29T00:00:00Z'),
  }
  const findMany = vi.fn(({ select }: { select?: Record<string, boolean> }) => {
    if (select?.accountId) {
      return Promise.resolve([
        { id: 'parent-1', fullText: 'parent text', accountId: 'parent-author' },
      ])
    }
    return Promise.resolve([{ id: 'parent-1', fullText: 'parent text' }])
  })
  const txClient = {
    account: {
      upsert: vi.fn().mockResolvedValue(authorProfile),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ ...authorProfile, recentTweetsFetchStatus: 'success' }),
    },
    tweet: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany,
      upsert: vi.fn().mockResolvedValue(upsertedReply),
    },
    crawlAuthorCheckpoint: { upsert: vi.fn().mockResolvedValue({}) },
  }
  const prisma = {
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txClient)),
  } as unknown as PrismaClient
  await persistAuthorResultAtomic(prisma, {
    crawlRunId: 'run1',
    username: 'tester',
    authorId: 'author1',
    profile: authorProfile,
    recentTweets: [tweet('reply-1', 'author1', { isReply: true, inReplyToTweetId: 'parent-1' })],
    additionalOwnTweets: [],
    recentTweetsFallbackAuthors: [],
    followSample: null,
    registry,
    labelDefinitionIds: new Map([[probeRule.key, 'def-1']]),
    duplicateReplyIndex: buildDuplicateReplyIndex([]),
    bioDuplicateIndex: buildBioDuplicateIndex([]),
    replyHijackIndex: buildReplyHijackIndex([]),
    followGraphLabelIndex: noFollowGraphSignals,
    selfReplyPromoIndex: buildSelfReplyPromoIndex([], []),
    warnings: [],
    durationMs: 0,
    retryWaitMs: 0,
    appVersion: 'test',
  })

  expect(observedParentAuthorId).toBe('parent-author')
  expect(findMany).toHaveBeenCalledWith({
    where: { id: { in: ['parent-1'] } },
    select: { id: true, fullText: true, accountId: true },
  })
})
