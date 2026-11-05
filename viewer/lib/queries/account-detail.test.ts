import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getAccountDetail } from './account-detail'

interface ActiveLabelFixture {
  labelDefinitionId: number
  confidence: number
  reason: string
  method: string
  ruleVersionNo: number
  labeledAt: Date
}

interface LabelDefinitionFixture {
  id: number
  key: string
  retiredAt: Date | null
  ruleVersions: { versionNo: number; ruleVersion: string }[]
}

/** AccountLabelState・AccountActiveLabel・LabelDefinition の prisma モックをまとめて作る。 */
function makeLabelStorage(
  input: {
    versions?: number[]
    active?: ActiveLabelFixture[]
    definitions?: LabelDefinitionFixture[]
  } = {},
) {
  const stateFindUnique = vi
    .fn()
    .mockResolvedValue(input.versions ? { versions: input.versions } : null)
  const activeFindMany = vi.fn().mockResolvedValue(input.active ?? [])
  const definitionFindMany = vi.fn().mockResolvedValue(input.definitions ?? [])
  return {
    stateFindUnique,
    activeFindMany,
    definitionFindMany,
    models: {
      accountLabelState: { findUnique: stateFindUnique },
      accountActiveLabel: { findMany: activeFindMany },
      labelDefinition: { findMany: definitionFindMany },
    },
  }
}

describe('getAccountDetail', () => {
  it('returns null when the account does not exist', async () => {
    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient

    const result = await getAccountDetail(prisma, 'missing', 10)

    expect(result).toBeNull()
  })

  it('assembles profile, label history (added→removed→added transitions), and recent tweets for an existing account', async () => {
    const account = {
      id: 'a1',
      screenName: 'alice',
      displayName: 'Alice',
      bio: 'hello',
      profileImageUrl: null,
      followersCount: 10,
      followingCount: 5,
      tweetCount: 200,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: true,
      verifiedType: 'Business',
    }
    const findUnique = vi.fn().mockResolvedValue(account)
    const labelStorage = makeLabelStorage({
      versions: [1, 1],
      active: [
        {
          labelDefinitionId: 1,
          confidence: 0.95,
          reason: 'reappeared spam pattern',
          method: 'heuristic',
          ruleVersionNo: 1,
          labeledAt: new Date('2026-07-03T00:00:00Z'),
        },
        {
          labelDefinitionId: 2,
          confidence: 0.8,
          reason: 'account behavior matches bot pattern',
          method: 'ai-generated',
          ruleVersionNo: 1,
          labeledAt: new Date('2026-07-01T00:00:00Z'),
        },
      ],
      definitions: [
        {
          id: 2,
          key: 'bot',
          retiredAt: null,
          ruleVersions: [{ versionNo: 1, ruleVersion: '1.0.0' }],
        },
        {
          id: 1,
          key: 'spam',
          retiredAt: null,
          ruleVersions: [{ versionNo: 1, ruleVersion: '1.2.0' }],
        },
      ],
    })
    // ld-spam は added(初回) → removed → added(現在値) の3回遷移している。
    // ld-bot は初回 added のみで、それ以降の遷移がない。
    const labelChangeFindMany = vi.fn().mockResolvedValue([
      {
        labelDefinitionId: 1,
        changeType: 'added',
        previousValue: false,
        newValue: true,
        previousConfidence: 0.9,
        newConfidence: 0.95,
        previousReason: 'no evidence',
        newReason: 'reappeared spam pattern',
        changedAt: new Date('2026-07-03T00:00:00Z'),
      },
      {
        labelDefinitionId: 1,
        changeType: 'removed',
        previousValue: true,
        newValue: false,
        previousConfidence: 0.95,
        newConfidence: 0.9,
        previousReason: 'matches keyword',
        newReason: 'no evidence',
        changedAt: new Date('2026-07-02T00:00:00Z'),
      },
      {
        labelDefinitionId: 1,
        changeType: 'added',
        previousValue: null,
        newValue: true,
        previousConfidence: null,
        newConfidence: 0.95,
        previousReason: null,
        newReason: 'matches keyword',
        changedAt: new Date('2026-07-01T00:00:00Z'),
      },
      {
        labelDefinitionId: 2,
        changeType: 'added',
        previousValue: null,
        newValue: true,
        previousConfidence: null,
        newConfidence: 0.8,
        previousReason: null,
        newReason: 'account behavior matches bot pattern',
        changedAt: new Date('2026-07-01T00:00:00Z'),
      },
    ])
    const tweetFindMany = vi.fn().mockResolvedValue([
      {
        id: 't1',
        fullText: 'hi',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        retweetCount: 1,
        likeCount: 2,
        isReply: false,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
      },
    ])
    const followFindMany = vi
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if ('followerId' in where) {
          return Promise.resolve([
            {
              followee: {
                id: 'f1',
                screenName: 'followee_one',
                displayName: 'Followee One',
                profileImageUrl: null,
              },
            },
          ])
        }
        return Promise.resolve([
          {
            follower: {
              id: 'f2',
              screenName: 'follower_two',
              displayName: 'Follower Two',
              profileImageUrl: null,
            },
          },
        ])
      })
    const followCount = vi
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve('followerId' in where ? 1 : 1),
      )
    const blockFindMany = vi.fn().mockResolvedValue([
      {
        blocked: {
          id: 'b1',
          screenName: 'blocked_one',
          displayName: 'Blocked One',
          profileImageUrl: null,
        },
      },
    ])
    const blockCount = vi.fn().mockResolvedValue(1)
    const prisma = {
      account: { findUnique },
      ...labelStorage.models,
      accountLabelChange: { findMany: labelChangeFindMany },
      tweet: { findMany: tweetFindMany },
      follow: { findMany: followFindMany, count: followCount },
      block: { findMany: blockFindMany, count: blockCount },
    } as unknown as PrismaClient

    const result = await getAccountDetail(prisma, 'a1', 10)

    expect(result).toEqual({
      account: {
        id: 'a1',
        screenName: 'alice',
        displayName: 'Alice',
        bio: 'hello',
        profileImageUrl: null,
        followersCount: 10,
        followingCount: 5,
        tweetCount: 200,
        accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
        isBlueVerified: true,
        verifiedType: 'Business',
      },
      labels: [
        {
          labelKey: 'spam',
          status: 'true',
          value: true,
          confidence: 0.95,
          reason: 'reappeared spam pattern',
          method: 'heuristic',
          ruleVersion: '1.2.0',
          labeledAt: new Date('2026-07-03T00:00:00Z'),
          history: [
            {
              changeType: 'added',
              previousValue: false,
              newValue: true,
              previousConfidence: 0.9,
              newConfidence: 0.95,
              previousReason: 'no evidence',
              newReason: 'reappeared spam pattern',
              changedAt: new Date('2026-07-03T00:00:00Z'),
            },
            {
              changeType: 'removed',
              previousValue: true,
              newValue: false,
              previousConfidence: 0.95,
              newConfidence: 0.9,
              previousReason: 'matches keyword',
              newReason: 'no evidence',
              changedAt: new Date('2026-07-02T00:00:00Z'),
            },
            {
              changeType: 'added',
              previousValue: null,
              newValue: true,
              previousConfidence: null,
              newConfidence: 0.95,
              previousReason: null,
              newReason: 'matches keyword',
              changedAt: new Date('2026-07-01T00:00:00Z'),
            },
          ],
        },
        {
          labelKey: 'bot',
          status: 'true',
          value: true,
          confidence: 0.8,
          reason: 'account behavior matches bot pattern',
          method: 'ai-generated',
          ruleVersion: '1.0.0',
          labeledAt: new Date('2026-07-01T00:00:00Z'),
          history: [
            {
              changeType: 'added',
              previousValue: null,
              newValue: true,
              previousConfidence: null,
              newConfidence: 0.8,
              previousReason: null,
              newReason: 'account behavior matches bot pattern',
              changedAt: new Date('2026-07-01T00:00:00Z'),
            },
          ],
        },
      ],
      recentTweets: [
        {
          id: 't1',
          fullText: 'hi',
          createdAt: new Date('2026-07-01T00:00:00Z'),
          retweetCount: 1,
          likeCount: 2,
          isReply: false,
          isRetweet: false,
          isPromoted: false,
          isPaidPromotion: false,
        },
      ],
      following: {
        entries: [
          {
            id: 'f1',
            screenName: 'followee_one',
            displayName: 'Followee One',
            profileImageUrl: null,
          },
        ],
        totalCount: 1,
      },
      followers: {
        entries: [
          {
            id: 'f2',
            screenName: 'follower_two',
            displayName: 'Follower Two',
            profileImageUrl: null,
          },
        ],
        totalCount: 1,
      },
      blocked: {
        entries: [
          {
            id: 'b1',
            screenName: 'blocked_one',
            displayName: 'Blocked One',
            profileImageUrl: null,
          },
        ],
        totalCount: 1,
      },
    })
    expect(tweetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { accountId: 'a1' }, take: 10 }),
    )
    expect(labelStorage.stateFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { accountId: 'a1' } }),
    )
    expect(labelStorage.activeFindMany).toHaveBeenCalledWith({ where: { accountId: 'a1' } })
    expect(labelChangeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'a1' },
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      }),
    )
  })

  it('returns empty following/followers lists when no edges are recorded', async () => {
    const account = {
      id: 'a2',
      screenName: 'bob',
      displayName: 'Bob',
      bio: null,
      profileImageUrl: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: false,
      verifiedType: null,
    }
    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(account) },
      ...makeLabelStorage().models,
      accountLabelChange: { findMany: vi.fn().mockResolvedValue([]) },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
      follow: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      block: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    } as unknown as PrismaClient

    const result = await getAccountDetail(prisma, 'a2', 10)

    expect(result?.following).toEqual({ entries: [], totalCount: 0 })
    expect(result?.followers).toEqual({ entries: [], totalCount: 0 })
  })

  it('caps the following/followers lists at 100 rows even when the true total is higher', async () => {
    const account = {
      id: 'a3',
      screenName: 'carol',
      displayName: 'Carol',
      bio: null,
      profileImageUrl: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: false,
      verifiedType: null,
    }
    const followFindMany = vi.fn().mockResolvedValue([])
    const followCount = vi.fn().mockResolvedValue(250)
    const blockFindMany = vi.fn().mockResolvedValue([])
    const blockCount = vi.fn().mockResolvedValue(250)
    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(account) },
      ...makeLabelStorage().models,
      accountLabelChange: { findMany: vi.fn().mockResolvedValue([]) },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
      follow: { findMany: followFindMany, count: followCount },
      block: { findMany: blockFindMany, count: blockCount },
    } as unknown as PrismaClient

    const result = await getAccountDetail(prisma, 'a3', 10)

    expect(result?.following.totalCount).toBe(250)
    expect(result?.followers.totalCount).toBe(250)
    expect(result?.blocked.totalCount).toBe(250)
    expect(followFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }))
    expect(blockFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }))
  })

  it('orders following/followers by lastSeenAt with a stable id tiebreaker', async () => {
    const account = {
      id: 'a4',
      screenName: 'dave',
      displayName: 'Dave',
      bio: null,
      profileImageUrl: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: false,
      verifiedType: null,
    }
    const followFindMany = vi.fn().mockResolvedValue([])
    const blockFindMany = vi.fn().mockResolvedValue([])
    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(account) },
      ...makeLabelStorage().models,
      accountLabelChange: { findMany: vi.fn().mockResolvedValue([]) },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
      follow: { findMany: followFindMany, count: vi.fn().mockResolvedValue(0) },
      block: { findMany: blockFindMany, count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient

    await getAccountDetail(prisma, 'a4', 10)

    expect(followFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { followerId: 'a4' },
        orderBy: [{ lastSeenAt: 'desc' }, { followeeId: 'asc' }],
      }),
    )
    expect(followFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { followeeId: 'a4' },
        orderBy: [{ lastSeenAt: 'desc' }, { followerId: 'asc' }],
      }),
    )
    expect(blockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blockerId: 'a4' },
        orderBy: [{ lastSeenAt: 'desc' }, { blockedId: 'asc' }],
      }),
    )
  })

  it('caps a single label history at 20 entries even when more evaluations exist', async () => {
    const account = {
      id: 'a5',
      screenName: 'erin',
      displayName: 'Erin',
      bio: null,
      profileImageUrl: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: false,
      verifiedType: null,
    }
    const changeRows = Array.from({ length: 25 }, (_, index) => ({
      labelDefinitionId: 1,
      changeType: 'added',
      previousValue: null,
      newValue: true,
      previousConfidence: null,
      newConfidence: 0.9,
      previousReason: null,
      newReason: `evaluation ${index}`,
      changedAt: new Date(2026, 6, 25 - index),
    }))
    const labelStorage = makeLabelStorage({
      versions: [1],
      active: [
        {
          labelDefinitionId: 1,
          confidence: 0.9,
          reason: 'evaluation 0',
          method: 'heuristic',
          ruleVersionNo: 1,
          labeledAt: new Date(2026, 6, 25),
        },
      ],
      definitions: [
        {
          id: 1,
          key: 'spam',
          retiredAt: null,
          ruleVersions: [{ versionNo: 1, ruleVersion: '1.0.0' }],
        },
      ],
    })
    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(account) },
      ...labelStorage.models,
      accountLabelChange: { findMany: vi.fn().mockResolvedValue(changeRows) },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
      follow: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      block: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    } as unknown as PrismaClient

    const result = await getAccountDetail(prisma, 'a5', 10)

    expect(result?.labels).toHaveLength(1)
    expect(result?.labels[0].history).toHaveLength(20)
  })

  it('caps the total number of AccountLabelChange rows fetched per account', async () => {
    const account = {
      id: 'a6',
      screenName: 'frank',
      displayName: 'Frank',
      bio: null,
      profileImageUrl: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: false,
      verifiedType: null,
    }
    const labelChangeFindMany = vi.fn().mockResolvedValue([])
    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(account) },
      ...makeLabelStorage().models,
      accountLabelChange: { findMany: labelChangeFindMany },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
      follow: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      block: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    } as unknown as PrismaClient

    await getAccountDetail(prisma, 'a6', 10)

    expect(labelChangeFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2000 }))
  })

  it('keeps a label visible from AccountActiveLabel even when its history rows are crowded out of the capped AccountLabelChange fetch', async () => {
    const account = {
      id: 'a7',
      screenName: 'grace',
      displayName: 'Grace',
      bio: null,
      profileImageUrl: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: false,
      verifiedType: null,
    }
    // 別ラベルの変化行だけで ACCOUNT_LABEL_CHANGE_FETCH_LIMIT を使い切り、
    // ld-quiet 自身の履歴行が取得結果に一件も含まれない状況を再現する。
    const labelStorage = makeLabelStorage({
      versions: [0, 0, 1],
      active: [
        {
          labelDefinitionId: 3,
          confidence: 0.7,
          reason: 'stable evaluation',
          method: 'heuristic',
          ruleVersionNo: 1,
          labeledAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      definitions: [
        {
          id: 3,
          key: 'quiet',
          retiredAt: null,
          ruleVersions: [{ versionNo: 1, ruleVersion: '1.0.0' }],
        },
      ],
    })
    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(account) },
      ...labelStorage.models,
      accountLabelChange: { findMany: vi.fn().mockResolvedValue([]) },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
      follow: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      block: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    } as unknown as PrismaClient

    const result = await getAccountDetail(prisma, 'a7', 10)

    expect(result?.labels).toEqual([
      {
        labelKey: 'quiet',
        status: 'true',
        value: true,
        confidence: 0.7,
        reason: 'stable evaluation',
        method: 'heuristic',
        ruleVersion: '1.0.0',
        labeledAt: new Date('2026-01-01T00:00:00Z'),
        history: [],
      },
    ])
  })

  it('shows false and unevaluable labels without a reason, skips unevaluated and retired ones', async () => {
    const account = {
      id: 'a8',
      screenName: 'henry',
      displayName: 'Henry',
      bio: null,
      profileImageUrl: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: false,
      verifiedType: null,
    }
    // versions の添字は LabelDefinition.id - 1。1 = never_triggered (false)、2 = few_samples (評価不能)、
    // 3 = not_yet (未評価)、4 = retired_false (廃止済みで false)、5 = retired_true (廃止済みで true)。
    const ruleVersions = [{ versionNo: 1, ruleVersion: '1.0.0' }]
    const labelStorage = makeLabelStorage({
      versions: [1, -1, 0, 1, 1],
      active: [
        {
          labelDefinitionId: 5,
          confidence: 0.6,
          reason: 'still true',
          method: 'heuristic',
          ruleVersionNo: 1,
          labeledAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      definitions: [
        { id: 2, key: 'few_samples', retiredAt: null, ruleVersions },
        { id: 1, key: 'never_triggered', retiredAt: null, ruleVersions },
        { id: 3, key: 'not_yet', retiredAt: null, ruleVersions },
        { id: 4, key: 'retired_false', retiredAt: new Date('2026-02-01T00:00:00Z'), ruleVersions },
        { id: 5, key: 'retired_true', retiredAt: new Date('2026-02-01T00:00:00Z'), ruleVersions },
      ],
    })
    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(account) },
      ...labelStorage.models,
      accountLabelChange: { findMany: vi.fn().mockResolvedValue([]) },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
      follow: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      block: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    } as unknown as PrismaClient

    const result = await getAccountDetail(prisma, 'a8', 10)

    expect(result?.labels).toEqual([
      {
        labelKey: 'retired_true',
        status: 'true',
        value: true,
        confidence: 0.6,
        reason: 'still true',
        method: 'heuristic',
        ruleVersion: '1.0.0',
        labeledAt: new Date('2026-01-01T00:00:00Z'),
        history: [],
      },
      {
        labelKey: 'few_samples',
        status: 'unevaluable',
        value: false,
        confidence: null,
        reason: null,
        method: null,
        ruleVersion: '1.0.0',
        labeledAt: null,
        history: [],
      },
      {
        labelKey: 'never_triggered',
        status: 'false',
        value: false,
        confidence: null,
        reason: null,
        method: null,
        ruleVersion: '1.0.0',
        labeledAt: null,
        history: [],
      },
    ])
  })

  it('returns no labels for an account that has never been evaluated', async () => {
    const account = {
      id: 'a9',
      screenName: 'ivy',
      displayName: 'Ivy',
      bio: null,
      profileImageUrl: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: false,
      verifiedType: null,
    }
    const labelStorage = makeLabelStorage({
      definitions: [
        {
          id: 1,
          key: 'spam',
          retiredAt: null,
          ruleVersions: [{ versionNo: 1, ruleVersion: '1.0.0' }],
        },
      ],
    })
    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(account) },
      ...labelStorage.models,
      accountLabelChange: { findMany: vi.fn().mockResolvedValue([]) },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
      follow: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      block: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient

    const result = await getAccountDetail(prisma, 'a9', 10)

    expect(result?.labels).toEqual([])
  })
})
