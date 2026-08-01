import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import { runRelabelBackfill } from './relabel'
import { LabelRuleRegistry } from './labels/registry'
import type { AccountFeatureBundle, LabelRule } from './labels/types'

const sampleAccount = {
  id: 'acc1',
  screenName: 'someone',
  displayName: 'Someone',
  bio: null,
  followersCount: 10,
  followingCount: 5,
  tweetCount: 3,
  accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
  isBlueVerified: false,
  verifiedType: null,
}

function makeRule(key: string, version: string, value = true): LabelRule {
  return {
    key,
    description: `test rule ${key}`,
    version,
    evaluate: () => ({ value, confidence: 1, reason: 'test' }),
  }
}

function makePrisma(overrides: {
  accounts?: (typeof sampleAccount)[][]
  latestRuleVersions?: { accountId: string; labelDefinitionId: string; ruleVersion: string }[]
  tweetFindManyImpl?: () => Promise<unknown[]>
  queryRawTweetRows?: unknown[]
  queryRawTweetError?: Error
  createImpl?: () => Promise<unknown>
}) {
  const accountBatches = overrides.accounts ?? [[sampleAccount], []]
  const findMany = vi.fn().mockImplementation(() => Promise.resolve(accountBatches.shift() ?? []))
  const upsert = vi
    .fn()
    .mockImplementation(({ create }: { create: { key: string } }) =>
      Promise.resolve({ id: `def-${create.key}`, ...create }),
    )
  const create = vi
    .fn()
    .mockImplementation(overrides.createImpl ?? (() => Promise.resolve({ id: 'label1' })))
  const tweetFindMany = vi
    .fn()
    .mockImplementation(overrides.tweetFindManyImpl ?? (() => Promise.resolve([])))
  // The first $queryRaw call is always loadLatestRuleVersions's; any call after that is
  // fetchTweetsForAccounts's batched per-account-batch tweet fetch.
  let queryRawCalls = 0
  const queryRaw = vi.fn().mockImplementation(() => {
    queryRawCalls++
    if (queryRawCalls === 1) {
      return Promise.resolve(overrides.latestRuleVersions ?? [])
    }
    if (overrides.queryRawTweetError) {
      return Promise.reject(overrides.queryRawTweetError)
    }
    return Promise.resolve(overrides.queryRawTweetRows ?? [])
  })

  const prisma = {
    account: { findMany },
    tweet: { findMany: tweetFindMany },
    labelDefinition: { upsert },
    accountLabel: { create },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient

  return { prisma, findMany, upsert, create, queryRaw, tweetFindMany }
}

describe('runRelabelBackfill', () => {
  it('persists a label for a rule the account has never been labeled with', async () => {
    const { prisma, create } = makePrisma({ accounts: [[sampleAccount], []] })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(create).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 1 })
  })

  it('skips a rule already at its current version for that account', async () => {
    const { prisma, create } = makePrisma({
      accounts: [[sampleAccount], []],
      latestRuleVersions: [
        { accountId: 'acc1', labelDefinitionId: 'def-rule-a', ruleVersion: '1.0.0' },
      ],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(create).not.toHaveBeenCalled()
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 0 })
  })

  it('re-persists a rule whose stored version is stale', async () => {
    const { prisma, create } = makePrisma({
      accounts: [[sampleAccount], []],
      latestRuleVersions: [
        { accountId: 'acc1', labelDefinitionId: 'def-rule-a', ruleVersion: '1.0.0' },
      ],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.1.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(create).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 1 })
  })

  it('continues to the next account after one account fails to persist its label', async () => {
    const account2 = { ...sampleAccount, id: 'acc2', screenName: 'other' }
    let call = 0
    const { prisma, create } = makePrisma({
      accounts: [[sampleAccount, account2], []],
      createImpl: () => {
        call++
        // Call 1 (acc1's persistence) is the one this test wants to fail; call 2 (acc2's)
        // must still go through, proving the per-account try/catch keeps the batch going.
        if (call === 1) {
          return Promise.reject(new Error('db error'))
        }
        return Promise.resolve({ id: 'label1' })
      },
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(create).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 1 })
  })

  it('paginates through multiple batches of accounts', async () => {
    const firstBatch = Array.from({ length: 100 }, (_, i) => ({
      ...sampleAccount,
      id: `acc${i}`,
      screenName: `user${i}`,
    }))
    const secondBatch = [{ ...sampleAccount, id: 'acc100', screenName: 'user100' }]
    const { prisma, findMany, create } = makePrisma({ accounts: [firstBatch, secondBatch, []] })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(findMany).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledTimes(101)
    expect(result).toEqual({ accountsProcessed: 101, labelsPersisted: 101 })
  })

  it('skips an account entirely (no tweet query) when every registered rule is already at its current version', async () => {
    const { prisma, tweetFindMany, queryRaw } = makePrisma({
      accounts: [[sampleAccount], []],
      latestRuleVersions: [
        { accountId: 'acc1', labelDefinitionId: 'def-rule-a', ruleVersion: '1.0.0' },
      ],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    // $queryRaw is called exactly once, for loadLatestRuleVersions - since the only
    // account is already fully up to date, fetchTweetsForAccounts's batched raw query is
    // never issued at all.
    expect(queryRaw).toHaveBeenCalledTimes(1)
    // tweet.findMany is only ever used for the shared reply corpus load, never per account.
    expect(tweetFindMany).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 0 })
  })

  it('still evaluates every rule for an account where only some rules are stale', async () => {
    const { prisma, create } = makePrisma({
      accounts: [[sampleAccount], []],
      latestRuleVersions: [
        { accountId: 'acc1', labelDefinitionId: 'def-rule-a', ruleVersion: '1.0.0' },
        { accountId: 'acc1', labelDefinitionId: 'def-rule-b', ruleVersion: '0.9.0' },
      ],
      queryRawTweetRows: [],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))
    registry.register(makeRule('rule-b', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(create).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 1 })
  })

  it('skips persisting a page whose batched tweet fetch fails, without rejecting the whole backfill', async () => {
    const { prisma, create } = makePrisma({
      accounts: [[sampleAccount], []],
      queryRawTweetError: new Error('connection reset'),
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    // The account is left un-persisted (not labeled from an empty, fetch-failure-induced
    // tweet sample) so it stays stale and a future run retries it with real data, rather
    // than the whole call rejecting or the account being wrongly marked up to date.
    expect(create).not.toHaveBeenCalled()
    expect(result).toEqual({ accountsProcessed: 0, labelsPersisted: 0 })
  })

  it('retries a page left stale by a prior fetch failure once the fetch succeeds', async () => {
    const tweetRow = {
      id: 't1',
      accountId: sampleAccount.id,
      fullText: 'hello',
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: null,
    }
    const { prisma, create } = makePrisma({
      accounts: [[sampleAccount], []],
      queryRawTweetRows: [tweetRow],
    })
    const registry = new LabelRuleRegistry()
    registry.register(makeRule('rule-a', '1.0.0'))

    const result = await runRelabelBackfill(prisma, registry)

    expect(create).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ accountsProcessed: 1, labelsPersisted: 1 })
  })

  it('fetches the top N most recent tweets per account when batching multiple accounts', async () => {
    const account2 = { ...sampleAccount, id: 'acc2', screenName: 'other' }
    const tweetRow = (id: string, accountId: string, fullText: string, createdAt: Date) => ({
      id,
      accountId,
      fullText,
      createdAt,
      retweetCount: 0,
      likeCount: 0,
      isReply: true,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: null,
    })
    const { prisma } = makePrisma({
      accounts: [[sampleAccount, account2], []],
      queryRawTweetRows: [
        tweetRow('t1', 'acc1', 'x newest', new Date('2026-01-03')),
        tweetRow('t2', 'acc1', 'x older', new Date('2026-01-02')),
        tweetRow('t3', 'acc2', 'y newest', new Date('2026-01-03')),
      ],
    })
    const registry = new LabelRuleRegistry()
    const seenBundles: AccountFeatureBundle[] = []
    registry.register({
      key: 'rule-a',
      description: 'test rule that records the bundle it saw',
      version: '1.0.0',
      evaluate: (bundle) => {
        seenBundles.push(bundle)
        return { value: true, confidence: 1, reason: 'test' }
      },
    })

    await runRelabelBackfill(prisma, registry)

    const bundleAcc1 = seenBundles.find((bundle) => bundle.account.id === 'acc1')
    const bundleAcc2 = seenBundles.find((bundle) => bundle.account.id === 'acc2')
    expect(bundleAcc1?.recentTweets.map((tweet) => tweet.id)).toEqual(['t1', 't2'])
    expect(bundleAcc2?.recentTweets.map((tweet) => tweet.id)).toEqual(['t3'])
  })

  it('wires quotedTweetAuthorId and quotedTweetHasVideo from the raw tweet row into the bundle', async () => {
    const tweetRow = {
      id: 't1',
      accountId: sampleAccount.id,
      fullText: 'quoting a video',
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: null,
      quotedTweetAuthorId: 'bob',
      quotedTweetHasVideo: true,
    }
    const { prisma } = makePrisma({
      accounts: [[sampleAccount], []],
      queryRawTweetRows: [tweetRow],
    })
    const registry = new LabelRuleRegistry()
    const seenBundles: AccountFeatureBundle[] = []
    registry.register({
      key: 'rule-a',
      description: 'test rule that records the bundle it saw',
      version: '1.0.0',
      evaluate: (bundle) => {
        seenBundles.push(bundle)
        return { value: true, confidence: 1, reason: 'test' }
      },
    })

    await runRelabelBackfill(prisma, registry)

    expect(seenBundles[0]?.recentTweets[0]).toMatchObject({
      quotedTweetAuthorId: 'bob',
      quotedTweetHasVideo: true,
    })
  })
})
