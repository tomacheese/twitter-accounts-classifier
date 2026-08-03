import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getAccountDetail } from './account-detail'

describe('getAccountDetail', () => {
  it('returns null when the account does not exist', async () => {
    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient

    const result = await getAccountDetail(prisma, 'missing', 10)

    expect(result).toBeNull()
  })

  it('assembles profile, label history, and recent tweets for an existing account', async () => {
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
    const labelFindMany = vi.fn().mockResolvedValue([
      {
        value: false,
        confidence: 0.95,
        reason: 'no longer matches keyword',
        method: 'heuristic',
        ruleVersion: '1.2.0',
        labeledAt: new Date('2026-07-03T00:00:00Z'),
        labelDefinitionId: 'ld-spam',
        labelDefinition: { key: 'spam' },
      },
      {
        value: false,
        confidence: 0.9,
        reason: 'matches keyword',
        method: 'heuristic',
        ruleVersion: '1.1.0',
        labeledAt: new Date('2026-07-02T00:00:00Z'),
        labelDefinitionId: 'ld-spam',
        labelDefinition: { key: 'spam' },
      },
      {
        value: false,
        confidence: 0.9,
        reason: 'matches keyword',
        method: 'heuristic',
        ruleVersion: '1.0.0',
        labeledAt: new Date('2026-07-01T00:00:00Z'),
        labelDefinitionId: 'ld-spam',
        labelDefinition: { key: 'spam' },
      },
      {
        value: true,
        confidence: 0.8,
        reason: 'account behavior matches bot pattern',
        method: 'ai-generated',
        ruleVersion: '1.0.0',
        labeledAt: new Date('2026-07-01T00:00:00Z'),
        labelDefinitionId: 'ld-bot',
        labelDefinition: { key: 'bot' },
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
      accountLabel: { findMany: labelFindMany },
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
          value: false,
          confidence: 0.95,
          reason: 'no longer matches keyword',
          method: 'heuristic',
          ruleVersion: '1.2.0',
          labeledAt: new Date('2026-07-03T00:00:00Z'),
          history: [
            {
              value: false,
              confidence: 0.9,
              reason: 'matches keyword',
              method: 'heuristic',
              ruleVersion: '1.1.0',
              labeledAt: new Date('2026-07-02T00:00:00Z'),
            },
            {
              value: false,
              confidence: 0.9,
              reason: 'matches keyword',
              method: 'heuristic',
              ruleVersion: '1.0.0',
              labeledAt: new Date('2026-07-01T00:00:00Z'),
            },
          ],
        },
        {
          labelKey: 'bot',
          value: true,
          confidence: 0.8,
          reason: 'account behavior matches bot pattern',
          method: 'ai-generated',
          ruleVersion: '1.0.0',
          labeledAt: new Date('2026-07-01T00:00:00Z'),
          history: [],
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
      accountLabel: { findMany: vi.fn().mockResolvedValue([]) },
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
      accountLabel: { findMany: vi.fn().mockResolvedValue([]) },
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
      accountLabel: { findMany: vi.fn().mockResolvedValue([]) },
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
})
