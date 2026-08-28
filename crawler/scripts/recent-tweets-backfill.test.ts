import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { AccountProfileInput } from '../db/account-repository'
import type { TweetInput } from '../db/tweet-repository'
import {
  createConfiguredAuthenticatedUserApi,
  parseOptions,
  runRecentTweetsBackfill,
  type AuthenticatedUserApiFactoryDependencies,
  type RecentTweetsBackfillDependencies,
} from './recent-tweets-backfill'

const profile: AccountProfileInput = {
  id: 'account-a',
  screenName: 'synthetic_account',
  displayName: 'Synthetic Account',
  bio: null,
  profileImageUrl: null,
  followersCount: 1,
  followingCount: 2,
  tweetCount: 3,
  accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
  location: null,
  url: null,
  isBlueVerified: false,
  verifiedType: null,
  professionalType: null,
  parodyCommentaryFanLabel: null,
}

const tweet: TweetInput = {
  id: 'tweet-a',
  accountId: 'account-a',
  fullText: 'synthetic tweet',
  createdAt: new Date('2026-08-24T00:00:00Z'),
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
  expandedUrls: [],
  hasAiGeneratedMedia: null,
  aiGeneratedDetectionSource: null,
  quotedTweetId: null,
  quotedTweetAuthorId: null,
  quotedTweetHasVideo: null,
  foreignVideoSourceCount: null,
  source: 'profile',
}

function makeDependencies(): RecentTweetsBackfillDependencies & {
  transaction: ReturnType<typeof vi.fn>
  accountUpdate: ReturnType<typeof vi.fn>
  accountUpdateMany: ReturnType<typeof vi.fn>
  authenticatedClose: ReturnType<typeof vi.fn>
  upsertTweet: ReturnType<typeof vi.fn>
} {
  const accountUpdate = vi.fn().mockResolvedValue({})
  const accountUpdateMany = vi.fn().mockResolvedValue({ count: 1 })
  const tx = {
    account: { update: accountUpdate, updateMany: accountUpdateMany },
  } as unknown as PrismaClient
  const transaction = vi.fn((fn: (transactionClient: PrismaClient) => Promise<unknown>) => fn(tx))
  const prisma = {
    $transaction: transaction,
    account: { update: accountUpdate, updateMany: accountUpdateMany },
  } as unknown as PrismaClient
  const authenticatedClose = vi.fn().mockResolvedValue(undefined)

  return {
    prisma,
    transaction,
    accountUpdate,
    accountUpdateMany,
    authenticatedClose,
    selectCandidates: vi.fn().mockResolvedValue({ accountIds: ['account-a'] }),
    loadConfig: vi.fn().mockReturnValue({
      accounts: [
        {
          email: 'synthetic-decoy@example.invalid',
          username: 'decoy-account',
          password: 'synthetic-decoy-password',
          otpSecret: 'synthetic-decoy-otp',
        },
        {
          email: 'synthetic@example.invalid',
          username: 'configured-account',
          password: 'synthetic-password',
          otpSecret: null,
        },
      ],
    }),
    createAuthenticatedUserApi: vi.fn().mockResolvedValue({
      userApi: {
        getUserByRestId: vi.fn(),
        getUserByScreenName: vi.fn(),
        getUserTweetsAndReplies: vi.fn(),
      },
      close: authenticatedClose,
    }),
    fetchAccountProfile: vi.fn().mockResolvedValue(profile),
    fetchRecentTweets: vi.fn().mockResolvedValue({ tweets: [tweet], authors: [profile] }),
    upsertAccount: vi.fn().mockResolvedValue({ account: profile, changed: false }),
    upsertFallbackAuthor: vi.fn().mockResolvedValue({ account: profile, changed: false }),
    upsertTweet: vi.fn().mockResolvedValue({ tweet, changed: true }),
    requestAccountRelabelBulk: vi.fn().mockResolvedValue(undefined),
    getRequestTimeoutMs: vi.fn().mockReturnValue(60_000),
    now: vi
      .fn()
      .mockReturnValueOnce(new Date('2026-08-24T00:00:00Z'))
      .mockReturnValue(new Date('2026-08-24T00:00:01Z')),
    log: vi.fn(),
    logError: vi.fn(),
    disconnectPrisma: vi.fn().mockResolvedValue(undefined),
  }
}

interface CoverageState {
  lastRecentTweetsAttemptedAt: Date | null
  lastRecentTweetsFetchedAt: Date | null
  recentTweetsFetchStatus: string | null
}

function installCoverageStateFake(
  deps: ReturnType<typeof makeDependencies>,
  coverage: CoverageState,
): void {
  vi.mocked(deps.accountUpdate).mockImplementation(({ data }: { data: Partial<CoverageState> }) => {
    Object.assign(coverage, data)
    return Promise.resolve({} as never)
  })
  vi.mocked(deps.accountUpdateMany).mockImplementation(
    ({
      where,
      data,
    }: {
      where: { lastRecentTweetsAttemptedAt: Date | null }
      data: Partial<CoverageState>
    }) => {
      const expectedAttempt = where.lastRecentTweetsAttemptedAt
      const currentAttempt = coverage.lastRecentTweetsAttemptedAt
      const matches =
        expectedAttempt === null
          ? currentAttempt === null
          : currentAttempt?.getTime() === expectedAttempt.getTime()
      if (!matches) return Promise.resolve({ count: 0 })
      Object.assign(coverage, data)
      return Promise.resolve({ count: 1 })
    },
  )
}

describe('parseOptions', () => {
  it('defaults to dry-run and validates the limit', () => {
    expect(parseOptions(['--limit', '100'])).toEqual({ limit: 100, execute: false })
    expect(() => parseOptions(['--limit', '0'])).toThrow('Limit must be an integer from 1 to 1000')
    expect(() => parseOptions(['--limit', '1001'])).toThrow(
      'Limit must be an integer from 1 to 1000',
    )
  })

  it('rejects conflicting modes and unknown arguments', () => {
    expect(() => parseOptions(['--dry-run', '--execute', '--username', 'account'])).toThrow(
      'Cannot combine --dry-run and --execute',
    )
    expect(() => parseOptions(['--unknown'])).toThrow('Unknown argument: --unknown')
  })

  it('requires an explicit username in execute mode', () => {
    expect(() => parseOptions(['--execute'])).toThrow('--execute requires --username')
  })
})

describe('runRecentTweetsBackfill', () => {
  it('keeps the default mode read-only and does not read credentials', async () => {
    const deps = makeDependencies()

    await runRecentTweetsBackfill(['--limit', '10'], deps)

    expect(deps.selectCandidates).toHaveBeenCalledWith(deps.prisma, {
      limit: 10,
      execute: false,
    })
    expect(deps.loadConfig).not.toHaveBeenCalled()
    expect(deps.createAuthenticatedUserApi).not.toHaveBeenCalled()
    expect(deps.fetchRecentTweets).not.toHaveBeenCalled()
    expect(deps.upsertTweet).not.toHaveBeenCalled()
    expect(deps.transaction).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      JSON.stringify({ mode: 'dry-run', accountIds: ['account-a'] }),
    )
  })

  it('uses exactly the configured username and persists a successful timeline atomically', async () => {
    const deps = makeDependencies()

    await runRecentTweetsBackfill(
      ['--limit', '1', '--execute', '--username', 'configured-account'],
      deps,
    )

    expect(deps.createAuthenticatedUserApi).toHaveBeenCalledWith(
      {
        email: 'synthetic@example.invalid',
        username: 'configured-account',
        password: 'synthetic-password',
        otpSecret: null,
      },
      60_000,
    )
    expect(deps.fetchRecentTweets).toHaveBeenCalledTimes(1)
    expect(deps.upsertTweet).toHaveBeenCalledWith(expect.anything(), tweet)
    expect(deps.requestAccountRelabelBulk).toHaveBeenCalledWith(expect.anything(), ['account-a'])
    expect(deps.transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 30_000,
      timeout: 30_000,
    })
    expect(deps.accountUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'account-a',
        lastRecentTweetsAttemptedAt: null,
      },
      data: {
        lastRecentTweetsAttemptedAt: new Date('2026-08-24T00:00:00Z'),
        lastRecentTweetsFetchedAt: new Date('2026-08-24T00:00:01Z'),
        recentTweetsFetchStatus: 'success',
      },
    })
    expect(deps.authenticatedClose).toHaveBeenCalledTimes(1)
    expect(deps.disconnectPrisma).toHaveBeenCalledTimes(1)
  })

  it('closes an OpenAPI context when adapting it fails', async () => {
    const adapterError = new Error('synthetic adapter failure')
    const context = {
      client: {
        getUserApi: vi.fn(() => {
          throw adapterError
        }),
        getTweetApi: vi.fn(),
      },
    }
    const closeContext = vi.fn().mockResolvedValue(undefined)
    const factoryDependencies = {
      getCookieIssuerBaseUrl: vi.fn().mockReturnValue('https://synthetic-issuer.invalid'),
      createCookieIssuerClient: vi.fn().mockReturnValue({
        issueCookiesWithRetry: vi.fn().mockResolvedValue({
          ct0: 'synthetic-ct0',
          authToken: 'synthetic-auth-token',
        }),
      }),
      createOpenApiClient: vi.fn().mockResolvedValue(context),
      closeOpenApiClient: closeContext,
      createUserApiLike: vi.fn(),
    } as unknown as AuthenticatedUserApiFactoryDependencies

    await expect(
      createConfiguredAuthenticatedUserApi(
        {
          email: 'synthetic@example.invalid',
          username: 'configured-account',
          password: 'synthetic-password',
          otpSecret: null,
        },
        60_000,
        factoryDependencies,
      ),
    ).rejects.toBe(adapterError)

    expect(closeContext).toHaveBeenCalledWith(context)
  })

  it('persists fallback authors before merged tweets in the success transaction', async () => {
    const deps = makeDependencies()
    const fallbackAuthor: AccountProfileInput = {
      ...profile,
      id: 'context-author',
      screenName: 'synthetic_context_author',
    }
    const promotedCopy: TweetInput = {
      ...tweet,
      fullText: 'newer synthetic tweet copy',
      isPromoted: true,
    }
    vi.mocked(deps.fetchRecentTweets).mockResolvedValue({
      tweets: [tweet, promotedCopy],
      authors: [profile, fallbackAuthor, fallbackAuthor],
    })

    await runRecentTweetsBackfill(
      ['--limit', '1', '--execute', '--username', 'configured-account'],
      deps,
    )

    expect(deps.upsertAccount).toHaveBeenCalledWith(expect.anything(), profile)
    expect(deps.upsertFallbackAuthor).toHaveBeenCalledWith(expect.anything(), fallbackAuthor)
    expect(deps.upsertTweet).toHaveBeenCalledWith(expect.anything(), promotedCopy)
    expect(vi.mocked(deps.upsertFallbackAuthor).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.upsertTweet).mock.invocationCallOrder[0],
    )
  })

  it('rolls back profile persistence and does not mark success or enqueue when one tweet fails', async () => {
    const deps = makeDependencies()
    let profileStaged = false
    let profileCommitted = false
    vi.mocked(deps.upsertAccount).mockImplementation(() => {
      profileStaged = true
      return Promise.resolve({ account: profile, changed: false } as never)
    })
    vi.mocked(deps.upsertTweet).mockRejectedValue(new Error('synthetic tweet persistence failure'))
    vi.mocked(deps.transaction).mockImplementation(
      async (fn: (transactionClient: PrismaClient) => Promise<unknown>) => {
        try {
          const result = await fn(deps.prisma)
          profileCommitted = profileStaged
          return result
        } catch (error) {
          profileStaged = false
          throw error
        }
      },
    )

    await expect(
      runRecentTweetsBackfill(
        ['--limit', '1', '--execute', '--username', 'configured-account'],
        deps,
      ),
    ).rejects.toThrow('synthetic tweet persistence failure')

    expect(profileCommitted).toBe(false)
    expect(deps.accountUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recentTweetsFetchStatus: 'success' }),
      }),
    )
    expect(deps.requestAccountRelabelBulk).not.toHaveBeenCalled()
  })

  it('disconnects Prisma even when authenticated client cleanup fails', async () => {
    const deps = makeDependencies()
    const closeError = new Error('synthetic close failure')
    const close = vi.fn().mockRejectedValue(closeError)
    vi.mocked(deps.createAuthenticatedUserApi).mockResolvedValue({
      userApi: {
        getUserByRestId: vi.fn(),
        getUserByScreenName: vi.fn(),
        getUserTweetsAndReplies: vi.fn(),
      },
      close,
    })

    await expect(
      runRecentTweetsBackfill(
        ['--limit', '1', '--execute', '--username', 'configured-account'],
        deps,
      ),
    ).rejects.toBe(closeError)

    expect(close).toHaveBeenCalledTimes(1)
    expect(deps.disconnectPrisma).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown username before cookie issuance or DB mutation', async () => {
    const deps = makeDependencies()

    await expect(
      runRecentTweetsBackfill(['--limit', '1', '--execute', '--username', 'unknown-account'], deps),
    ).rejects.toThrow('Configured account not found: unknown-account')

    expect(deps.createAuthenticatedUserApi).not.toHaveBeenCalled()
    expect(deps.transaction).not.toHaveBeenCalled()
    expect(deps.accountUpdate).not.toHaveBeenCalled()
  })

  it('rejects execute without a username before reading credentials or DB mutation', async () => {
    const deps = makeDependencies()

    await expect(runRecentTweetsBackfill(['--limit', '1', '--execute'], deps)).rejects.toThrow(
      '--execute requires --username',
    )

    expect(deps.loadConfig).not.toHaveBeenCalled()
    expect(deps.createAuthenticatedUserApi).not.toHaveBeenCalled()
    expect(deps.transaction).not.toHaveBeenCalled()
    expect(deps.accountUpdate).not.toHaveBeenCalled()
  })

  it.each(['profile', 'timeline'] as const)(
    'records a failed %s fetch without replacing successful coverage or enqueueing',
    async (failedFetch) => {
      const deps = makeDependencies()
      if (failedFetch === 'profile') {
        vi.mocked(deps.fetchAccountProfile).mockRejectedValue(
          new Error('synthetic profile failure'),
        )
      } else {
        vi.mocked(deps.fetchRecentTweets).mockRejectedValue(new Error('synthetic timeline failure'))
      }

      await runRecentTweetsBackfill(
        ['--limit', '1', '--execute', '--username', 'configured-account'],
        deps,
      )

      expect(deps.accountUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'account-a',
          lastRecentTweetsAttemptedAt: null,
        },
        data: {
          lastRecentTweetsAttemptedAt: new Date('2026-08-24T00:00:00Z'),
          recentTweetsFetchStatus: 'failed',
        },
      })
      expect(deps.accountUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastRecentTweetsFetchedAt: expect.anything() }),
        }),
      )
      expect(deps.requestAccountRelabelBulk).not.toHaveBeenCalled()
    },
  )

  it('does not apply an older successful fetch after a newer normal-crawl success', async () => {
    const deps = makeDependencies()
    const coverage: CoverageState = {
      lastRecentTweetsAttemptedAt: null,
      lastRecentTweetsFetchedAt: null,
      recentTweetsFetchStatus: null,
    }
    installCoverageStateFake(deps, coverage)
    vi.mocked(deps.fetchRecentTweets).mockImplementation(() => {
      coverage.lastRecentTweetsAttemptedAt = new Date('2026-08-24T00:00:02Z')
      coverage.lastRecentTweetsFetchedAt = new Date('2026-08-24T00:00:03Z')
      coverage.recentTweetsFetchStatus = 'success'
      return Promise.resolve({ tweets: [tweet], authors: [profile] })
    })

    await runRecentTweetsBackfill(
      ['--limit', '1', '--execute', '--username', 'configured-account'],
      deps,
    )

    expect(coverage).toEqual({
      lastRecentTweetsAttemptedAt: new Date('2026-08-24T00:00:02Z'),
      lastRecentTweetsFetchedAt: new Date('2026-08-24T00:00:03Z'),
      recentTweetsFetchStatus: 'success',
    })
    expect(deps.requestAccountRelabelBulk).not.toHaveBeenCalled()
  })

  it('does not downgrade a newer normal-crawl success after an older fetch failure', async () => {
    const deps = makeDependencies()
    const coverage: CoverageState = {
      lastRecentTweetsAttemptedAt: null,
      lastRecentTweetsFetchedAt: null,
      recentTweetsFetchStatus: null,
    }
    installCoverageStateFake(deps, coverage)
    vi.mocked(deps.fetchAccountProfile).mockImplementation(() => {
      coverage.lastRecentTweetsAttemptedAt = new Date('2026-08-24T00:00:02Z')
      coverage.lastRecentTweetsFetchedAt = new Date('2026-08-24T00:00:03Z')
      coverage.recentTweetsFetchStatus = 'success'
      return Promise.reject(new Error('synthetic profile failure'))
    })

    await runRecentTweetsBackfill(
      ['--limit', '1', '--execute', '--username', 'configured-account'],
      deps,
    )

    expect(coverage).toEqual({
      lastRecentTweetsAttemptedAt: new Date('2026-08-24T00:00:02Z'),
      lastRecentTweetsFetchedAt: new Date('2026-08-24T00:00:03Z'),
      recentTweetsFetchStatus: 'success',
    })
  })
})
