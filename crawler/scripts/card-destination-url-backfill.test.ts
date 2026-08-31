import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { AccountProfileInput } from '../db/account-repository'
import type { TweetInput } from '../db/tweet-repository'
import {
  runCardDestinationUrlBackfill,
  type CardDestinationUrlBackfillDependencies,
} from './card-destination-url-backfill'

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
  cardDestinationUrls: ['https://www.amazon.co.jp/dp/FICTIONAL?tag=fictional-22'],
  cardDestinationUrlsEvaluated: true,
  hasAiGeneratedMedia: null,
  aiGeneratedDetectionSource: null,
  quotedTweetId: null,
  quotedTweetAuthorId: null,
  quotedTweetHasVideo: null,
  foreignVideoSourceCount: null,
  source: 'profile',
}

function makeDependencies(): CardDestinationUrlBackfillDependencies & {
  transaction: ReturnType<typeof vi.fn>
  authenticatedClose: ReturnType<typeof vi.fn>
} {
  const tx = {} as unknown as PrismaClient
  const transaction = vi.fn((fn: (transactionClient: PrismaClient) => Promise<unknown>) => fn(tx))
  const prisma = { $transaction: transaction } as unknown as PrismaClient
  const authenticatedClose = vi.fn().mockResolvedValue(undefined)

  return {
    prisma,
    transaction,
    authenticatedClose,
    selectCandidates: vi.fn().mockResolvedValue({ accountIds: ['account-a'] }),
    loadConfig: vi.fn().mockReturnValue({
      accounts: [
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
    log: vi.fn(),
    logError: vi.fn(),
    disconnectPrisma: vi.fn().mockResolvedValue(undefined),
  }
}

describe('runCardDestinationUrlBackfill', () => {
  it('keeps the default mode read-only and does not read credentials', async () => {
    const deps = makeDependencies()

    await runCardDestinationUrlBackfill(['--limit', '10'], deps)

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

  it('rejects an unknown username before cookie issuance or DB mutation', async () => {
    const deps = makeDependencies()

    await expect(
      runCardDestinationUrlBackfill(
        ['--limit', '1', '--execute', '--username', 'unknown-account'],
        deps,
      ),
    ).rejects.toThrow('Configured account not found: unknown-account')

    expect(deps.createAuthenticatedUserApi).not.toHaveBeenCalled()
    expect(deps.transaction).not.toHaveBeenCalled()
  })

  it('rejects execute without a username before reading credentials or DB mutation', async () => {
    const deps = makeDependencies()

    await expect(
      runCardDestinationUrlBackfill(['--limit', '1', '--execute'], deps),
    ).rejects.toThrow('--execute requires --username')

    expect(deps.loadConfig).not.toHaveBeenCalled()
    expect(deps.createAuthenticatedUserApi).not.toHaveBeenCalled()
    expect(deps.transaction).not.toHaveBeenCalled()
  })

  it('uses exactly the configured username and persists a re-fetched timeline atomically', async () => {
    const deps = makeDependencies()

    await runCardDestinationUrlBackfill(
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
    expect(deps.fetchAccountProfile).toHaveBeenCalledWith(expect.anything(), 'account-a')
    expect(deps.fetchRecentTweets).toHaveBeenCalledWith(
      expect.anything(),
      'account-a',
      expect.any(Number),
    )
    expect(deps.upsertAccount).toHaveBeenCalledWith(expect.anything(), profile)
    expect(deps.upsertTweet).toHaveBeenCalledWith(expect.anything(), tweet)
    expect(deps.requestAccountRelabelBulk).toHaveBeenCalledWith(expect.anything(), ['account-a'])
    expect(deps.transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 30_000,
      timeout: 30_000,
    })
    expect(deps.authenticatedClose).toHaveBeenCalledTimes(1)
    expect(deps.disconnectPrisma).toHaveBeenCalledTimes(1)
  })

  it('does not request a relabel when no upserted tweet actually changed', async () => {
    const deps = makeDependencies()
    vi.mocked(deps.upsertTweet).mockResolvedValue({ tweet: tweet as never, changed: false })

    await runCardDestinationUrlBackfill(
      ['--limit', '1', '--execute', '--username', 'configured-account'],
      deps,
    )

    expect(deps.requestAccountRelabelBulk).not.toHaveBeenCalled()
  })

  it('logs and continues to the next candidate when a fetch fails, without persisting it', async () => {
    const deps = makeDependencies()
    vi.mocked(deps.selectCandidates).mockResolvedValue({ accountIds: ['account-a', 'account-b'] })
    vi.mocked(deps.fetchAccountProfile)
      .mockRejectedValueOnce(new Error('synthetic profile fetch failure'))
      .mockResolvedValueOnce(profile)

    await runCardDestinationUrlBackfill(
      ['--limit', '2', '--execute', '--username', 'configured-account'],
      deps,
    )

    expect(deps.logError).toHaveBeenCalledWith(
      'Card destination URL backfill fetch failed for account-a',
    )
    expect(deps.upsertTweet).toHaveBeenCalledTimes(1)
    expect(deps.disconnectPrisma).toHaveBeenCalledTimes(1)
  })

  it('does nothing further when there are no candidates in execute mode', async () => {
    const deps = makeDependencies()
    vi.mocked(deps.selectCandidates).mockResolvedValue({ accountIds: [] })

    await runCardDestinationUrlBackfill(
      ['--limit', '1', '--execute', '--username', 'configured-account'],
      deps,
    )

    expect(deps.createAuthenticatedUserApi).not.toHaveBeenCalled()
    expect(deps.disconnectPrisma).toHaveBeenCalledTimes(1)
  })
})
