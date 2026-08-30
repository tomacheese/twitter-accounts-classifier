import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { PrismaClient, Tweet } from './generated/prisma'
import { LabelRuleRegistry } from './labels/registry'
import type { AccountFeatureBundle, LabelRule } from './labels/types'
import * as workItemRepository from './db/analysis-work-item-repository'
import * as labelRepository from './db/label-repository'
import * as tweetRepository from './db/tweet-repository'
import * as followGraphIndexModule from './labels/follow-graph-label-index'
import * as replyCorpusModule from './db/reply-corpus'
import * as bioCorpusModule from './db/bio-corpus'
import * as selfReplyPromoCorpusModule from './db/self-reply-promo-corpus'
import * as evidenceRepository from './db/reply-hijack-evidence-repository'
import { replyHijackSwarmRule } from './labels/rules/reply-hijack-swarm'
import {
  evaluateAccountRelabelItems,
  runRelabelWorkerCycleOnce,
  scanForStaleAccounts,
} from './relabel-worker'

function makeTransactionalPrisma(client: Record<string, unknown>): PrismaClient {
  const prisma = client as unknown as PrismaClient
  Object.assign(client, {
    $transaction: vi.fn((fn: (tx: PrismaClient) => Promise<unknown>) => fn(prisma)),
  })
  return prisma
}

describe('evaluateAccountRelabelItems', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // 個別のテストで上書きしない限り、渡された work item は全て lease を保持し続けている前提にする。
    vi.spyOn(workItemRepository, 'claimStillLeasedWorkItemIdsForUpdate').mockImplementation(
      (_tx, input) => Promise.resolve(input.workItemIds),
    )
  })

  it('永続化を lease の生存確認から work item 完了まで 1 本の transaction にまとめて行う', async () => {
    const registry = new LabelRuleRegistry()
    registry.register(replyHijackSwarmRule)
    const prisma = makeTransactionalPrisma({
      account: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'account-1', recentTweetsFetchStatus: 'success' }]),
      },
    })
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(
      new Map([
        [
          'account-1',
          [
            { id: 'reply-1', isReply: true, inReplyToTweetId: 'target-1' },
            { id: 'reply-2', isReply: true, inReplyToTweetId: 'target-1' },
            { id: 'post-1', isReply: false, inReplyToTweetId: null },
          ] as Tweet[],
        ],
      ]),
    )
    vi.spyOn(tweetRepository, 'findTweetContextsByIds').mockResolvedValue(new Map())
    const recordLabelsSpy = vi
      .spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts')
      .mockResolvedValue([])
    const evidenceSpy = vi
      .spyOn(evidenceRepository, 'upsertReplyHijackEvidence')
      .mockResolvedValue()
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockResolvedValue([{ id: 'wi-1', status: 'succeeded' }])

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'account-1' } as never],
      {
        registry,
        labelDefinitionIds: new Map([['reply_hijack_swarm', 'def-1']]),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        bioDuplicateIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: {
          swarmSizeFor: () => 5,
          isEligibleForScreening: () => true,
          evidenceFor: () => ({
            targetTweetId: 'target-1',
            swarmSize: 5,
            averageSimilarity: 0.8,
            spanHours: 3,
            replyTweetIds: ['reply-1', 'reply-2'],
          }),
        },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        selfReplyPromoIndex: { evidenceFor: () => undefined },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    expect(result.succeeded).toBe(1)
    expect(recordLabelsSpy).toHaveBeenCalledWith(prisma, expect.anything())
    expect(evidenceSpy).toHaveBeenCalledWith(prisma, {
      accountId: 'account-1',
      targetTweetId: 'target-1',
      ruleVersion: replyHijackSwarmRule.version,
      swarmSize: 5,
      averageSimilarity: 0.8,
      spanHours: 3,
      replyTweetIds: ['reply-1', 'reply-2'],
    })
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-1'],
      leaseOwner: 'test-worker',
    })
    // lease (5分) より十分短い timeout でサブバッチ transaction が完結する設計になっている。
    const transactionOptions = (prisma.$transaction as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as { maxWait: number; timeout: number }
    expect(transactionOptions.timeout).toBeLessThan(60_000)
    expect(transactionOptions.maxWait).toBeLessThan(transactionOptions.timeout)
  })

  it('does not persist reply-hijack evidence when the reply-ratio guard rejects the account', async () => {
    const registry = new LabelRuleRegistry()
    registry.register(replyHijackSwarmRule)
    const prisma = makeTransactionalPrisma({
      account: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'account-1', recentTweetsFetchStatus: 'success' }]),
      },
    })
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(
      new Map([
        [
          'account-1',
          [
            { id: 'reply-1', isReply: true, inReplyToTweetId: 'target-1' },
            { id: 'post-1', isReply: false, inReplyToTweetId: null },
            { id: 'post-2', isReply: false, inReplyToTweetId: null },
          ] as Tweet[],
        ],
      ]),
    )
    vi.spyOn(tweetRepository, 'findTweetContextsByIds').mockResolvedValue(new Map())
    vi.spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts').mockResolvedValue([])
    const evidenceSpy = vi
      .spyOn(evidenceRepository, 'upsertReplyHijackEvidence')
      .mockResolvedValue()
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockResolvedValue([
      { id: 'wi-1', status: 'succeeded' },
    ])

    await evaluateAccountRelabelItems(prisma, [{ id: 'wi-1', triggerId: 'account-1' } as never], {
      registry,
      labelDefinitionIds: new Map([['reply_hijack_swarm', 'def-1']]),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      bioDuplicateIndex: { countOtherAccounts: () => 0 },
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
      followGraphLabelIndex: { signalsFor: () => ({}) },
      selfReplyPromoIndex: { evidenceFor: () => undefined },
      concurrency: 1,
      leaseOwner: 'test-worker',
    })

    expect(evidenceSpy).not.toHaveBeenCalled()
  })

  it('evidence 永続化が失敗した場合、同じ transaction 内のラベル書き込みも roll back され work item は complete しない', async () => {
    const registry = new LabelRuleRegistry()
    registry.register(replyHijackSwarmRule)
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const prisma = makeTransactionalPrisma({
      account: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'account-1', recentTweetsFetchStatus: 'success' }]),
      },
      analysisWorkItem: { updateMany },
    })
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(
      new Map([
        [
          'account-1',
          [
            { id: 'reply-1', isReply: true, inReplyToTweetId: 'target-1' },
            { id: 'reply-2', isReply: true, inReplyToTweetId: 'target-1' },
            { id: 'post-1', isReply: false, inReplyToTweetId: null },
          ] as Tweet[],
        ],
      ]),
    )
    vi.spyOn(tweetRepository, 'findTweetContextsByIds').mockResolvedValue(new Map())
    const recordLabelsSpy = vi
      .spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts')
      .mockResolvedValue([])
    vi.spyOn(evidenceRepository, 'upsertReplyHijackEvidence').mockRejectedValue(
      new Error('evidence write failed'),
    )
    const completeSpy = vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'account-1' } as never],
      {
        registry,
        labelDefinitionIds: new Map([['reply_hijack_swarm', 'def-1']]),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        bioDuplicateIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: {
          swarmSizeFor: () => 5,
          isEligibleForScreening: () => true,
          evidenceFor: () => ({
            targetTweetId: 'target-1',
            swarmSize: 5,
            averageSimilarity: 0.8,
            spanHours: 3,
            replyTweetIds: ['reply-1', 'reply-2'],
          }),
        },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        selfReplyPromoIndex: { evidenceFor: () => undefined },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    // ラベル書き込みは transaction 内で試みられるが、直後の evidence 書き込み失敗により
    // transaction 全体が roll back されるため、recordAccountLabelsBulkForAccounts が
    // 冪等な UPSERT である以上、次回の再試行でも安全にやり直せる。
    expect(result.succeeded).toBe(0)
    expect(recordLabelsSpy).toHaveBeenCalledWith(prisma, expect.anything())
    expect(completeSpy).not.toHaveBeenCalled()
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['wi-1'] }, status: { not: 'succeeded' } },
      data: { lastErrorSummary: expect.stringContaining('evidence write failed') as string },
    })
  })

  it('transaction 内の生存確認で lease を失っている account はラベル・evidence を書き込まず、work item も complete しない', async () => {
    // claimStillLeasedWorkItemIdsForUpdate が FOR UPDATE SKIP LOCKED で返す id だけを
    // 書き込み対象にすることで、生存確認時点で既に lease を失っていた account の
    // 古い評価結果が誤って書き込まれないことを確認する。
    const rule: LabelRule = {
      key: 'test_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: () => ({ value: true, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    const prisma = makeTransactionalPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([{ id: 'alice' }, { id: 'bob' }]),
      },
    })
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())
    vi.spyOn(tweetRepository, 'findTweetContextsByIds').mockResolvedValue(new Map())
    const recordLabelsSpy = vi
      .spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts')
      .mockResolvedValue([])
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockResolvedValue([{ id: 'wi-bob', status: 'succeeded' }])
    // alice の work item だけ lease を失っている状態を模擬する (bob は保持したまま)。
    vi.spyOn(workItemRepository, 'claimStillLeasedWorkItemIdsForUpdate').mockResolvedValue([
      'wi-bob',
    ])

    const result = await evaluateAccountRelabelItems(
      prisma,
      [
        { id: 'wi-alice', triggerId: 'alice' } as never,
        { id: 'wi-bob', triggerId: 'bob' } as never,
      ],
      {
        registry,
        labelDefinitionIds: new Map([['test_rule', 'def-1']]),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        bioDuplicateIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: {
          swarmSizeFor: () => 0,
          isEligibleForScreening: () => true,
          evidenceFor: () => undefined,
        },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        selfReplyPromoIndex: { evidenceFor: () => undefined },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    expect(result.succeeded).toBe(1)
    expect(recordLabelsSpy).toHaveBeenCalledWith(prisma, {
      sourceKind: 'relabel',
      labels: [
        {
          accountId: 'bob',
          labelDefinitionId: 'def-1',
          method: 'test_rule',
          ruleVersion: '1.0.0',
          result: { value: true, confidence: 1, reason: 'test' },
        },
      ],
    })
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-bob'],
      leaseOwner: 'test-worker',
    })
  })

  it('claim 済みの work item を評価・complete まで処理する', async () => {
    const rule: LabelRule = {
      key: 'test_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: () => ({ value: true, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockResolvedValue([{ id: 'wi-1', status: 'succeeded' }])
    const recordLabelsSpy = vi
      .spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts')
      .mockResolvedValue([])
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())

    const prisma = makeTransactionalPrisma({
      account: { findMany: vi.fn().mockResolvedValue([{ id: 'alice' }]) },
    })

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'alice' } as never],
      {
        registry,
        labelDefinitionIds: new Map([['test_rule', 'def-1']]),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        bioDuplicateIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: {
          swarmSizeFor: () => 0,
          isEligibleForScreening: () => true,
          evidenceFor: () => undefined,
        },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        selfReplyPromoIndex: { evidenceFor: () => undefined },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    expect(result.succeeded).toBe(1)
    expect(recordLabelsSpy).toHaveBeenCalledWith(prisma, {
      sourceKind: 'relabel',
      labels: [
        {
          accountId: 'alice',
          labelDefinitionId: 'def-1',
          method: 'test_rule',
          ruleVersion: '1.0.0',
          result: { value: true, confidence: 1, reason: 'test' },
        },
      ],
    })
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-1'],
      leaseOwner: 'test-worker',
    })
  })

  it('resolves parentTweetFullText for reply tweets before evaluating rules', async () => {
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

    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockResolvedValue([
      { id: 'wi-1', status: 'succeeded' },
    ])
    vi.spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts').mockResolvedValue([])
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(
      new Map([
        [
          'alice',
          [
            {
              id: 't1',
              fullText: 'reply text',
              isReply: true,
              inReplyToTweetId: 'parent1',
            } as unknown as Tweet,
          ],
        ],
      ]),
    )
    vi.spyOn(tweetRepository, 'findTweetContextsByIds').mockResolvedValue(
      new Map([['parent1', { fullText: '親ツイートの本文です', accountId: 'parent-author' }]]),
    )

    const prisma = makeTransactionalPrisma({
      account: { findMany: vi.fn().mockResolvedValue([{ id: 'alice' }]) },
    })

    await evaluateAccountRelabelItems(prisma, [{ id: 'wi-1', triggerId: 'alice' } as never], {
      registry,
      labelDefinitionIds: new Map([['capture_rule', 'def-1']]),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      bioDuplicateIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: {
        swarmSizeFor: () => 0,
        isEligibleForScreening: () => true,
        evidenceFor: () => undefined,
      },
      followGraphLabelIndex: { signalsFor: () => ({}) },
      selfReplyPromoIndex: { evidenceFor: () => undefined },
      concurrency: 1,
      leaseOwner: 'test-worker',
    })

    expect(capturedBundle?.recentTweets[0].parentTweetFullText).toBe('親ツイートの本文です')
  })

  it('account が既に削除されている場合は評価をスキップして succeeded 扱いにする', async () => {
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockResolvedValue([{ id: 'wi-1', status: 'succeeded' }])
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())

    const prisma = makeTransactionalPrisma({
      account: { findMany: vi.fn().mockResolvedValue([]) },
    })

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'deleted-account' } as never],
      {
        registry: new LabelRuleRegistry(),
        labelDefinitionIds: new Map(),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        bioDuplicateIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: {
          swarmSizeFor: () => 0,
          isEligibleForScreening: () => true,
          evidenceFor: () => undefined,
        },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        selfReplyPromoIndex: { evidenceFor: () => undefined },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    expect(result.succeeded).toBe(1)
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-1'],
      leaseOwner: 'test-worker',
    })
  })

  it('concurrency を 2 以上に設定すると複数グループへ分割して並走する', async () => {
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockImplementation(
      (_prisma, { workItemIds }) =>
        Promise.resolve(workItemIds.map((id) => ({ id, status: 'succeeded' as const }))),
    )
    vi.spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts').mockResolvedValue([])
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())
    const pendingResolvers: (() => void)[] = []
    const prisma = makeTransactionalPrisma({
      account: {
        findMany: vi.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) => {
          return new Promise((resolve) => {
            pendingResolvers.push(() => {
              resolve(where.id.in.map((id) => ({ id })))
            })
          })
        }),
      },
    })

    const items = [
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
      { id: 'wi-3', triggerId: 'carol' },
      { id: 'wi-4', triggerId: 'dave' },
    ] as never[]

    const resultPromise = evaluateAccountRelabelItems(prisma, items, {
      registry: new LabelRuleRegistry(),
      labelDefinitionIds: new Map(),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      bioDuplicateIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: {
        swarmSizeFor: () => 0,
        isEligibleForScreening: () => true,
        evidenceFor: () => undefined,
      },
      followGraphLabelIndex: { signalsFor: () => ({}) },
      selfReplyPromoIndex: { evidenceFor: () => undefined },
      concurrency: 2,
      leaseOwner: 'test-worker',
    })

    // concurrency: 2 なら group (alice→carol) と group (bob→dave) が同時に走り出すため、
    // 両グループ先頭の account.findMany が解決前に 2 件同時に保留する。
    // concurrency: 1 の直列実行ではこの時点で保留は 1 件にしかならないため、この件数がグループ並走の検証点になる。
    expect(pendingResolvers).toHaveLength(2)

    while (pendingResolvers.length > 0) {
      const toResolve = pendingResolvers.splice(0)
      for (const resolve of toResolve) resolve()
      for (let i = 0; i < 10; i++) {
        await Promise.resolve()
      }
    }

    const result = await resultPromise
    expect(result.succeeded).toBe(4)
  })

  it('複数 account を 1 グループにまとめても、ラベルと直近ツイートが account ごとに正しく紐付く', async () => {
    const rule: LabelRule = {
      key: 'tweet_count_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: (bundle) => ({
        value: bundle.recentTweets.length > 0,
        confidence: 1,
        reason: bundle.recentTweets.map((tweet) => tweet.id).join(','),
      }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    const recordLabelsSpy = vi
      .spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts')
      .mockResolvedValue([])
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockImplementation(
      (_prisma, { workItemIds }) =>
        Promise.resolve(workItemIds.map((id) => ({ id, status: 'succeeded' as const }))),
    )
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(
      new Map([
        ['alice', [{ id: 'tweet-alice-1', inReplyToTweetId: null }] as never],
        ['bob', [] as never],
      ]),
    )

    const prisma = makeTransactionalPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([{ id: 'alice' }, { id: 'bob' }]),
      },
    })

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'alice' } as never, { id: 'wi-2', triggerId: 'bob' } as never],
      {
        registry,
        labelDefinitionIds: new Map([['tweet_count_rule', 'def-1']]),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        bioDuplicateIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: {
          swarmSizeFor: () => 0,
          isEligibleForScreening: () => true,
          evidenceFor: () => undefined,
        },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        selfReplyPromoIndex: { evidenceFor: () => undefined },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    expect(result.succeeded).toBe(2)
    expect(recordLabelsSpy).toHaveBeenCalledWith(prisma, {
      sourceKind: 'relabel',
      labels: [
        {
          accountId: 'alice',
          labelDefinitionId: 'def-1',
          method: 'tweet_count_rule',
          ruleVersion: '1.0.0',
          result: { value: true, confidence: 1, reason: 'tweet-alice-1' },
        },
        {
          accountId: 'bob',
          labelDefinitionId: 'def-1',
          method: 'tweet_count_rule',
          ruleVersion: '1.0.0',
          result: { value: false, confidence: 1, reason: '' },
        },
      ],
    })
  })

  it('1 account のルール評価が例外を投げても、他 account は succeeded のまま完了する', async () => {
    const rule: LabelRule = {
      key: 'throwing_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: (bundle) => {
        if (bundle.account.id === 'bob') throw new Error('broken account data')
        return { value: true, confidence: 1, reason: 'test' }
      },
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    const recordLabelsSpy = vi
      .spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts')
      .mockResolvedValue([])
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockImplementation((_prisma, { workItemIds }) =>
        Promise.resolve(workItemIds.map((id) => ({ id, status: 'succeeded' as const }))),
      )
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())
    const updateSpy = vi.fn().mockResolvedValue({})

    const prisma = makeTransactionalPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([{ id: 'alice' }, { id: 'bob' }]),
      },
      analysisWorkItem: { update: updateSpy },
    })

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'alice' } as never, { id: 'wi-2', triggerId: 'bob' } as never],
      {
        registry,
        labelDefinitionIds: new Map([['throwing_rule', 'def-1']]),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        bioDuplicateIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: {
          swarmSizeFor: () => 0,
          isEligibleForScreening: () => true,
          evidenceFor: () => undefined,
        },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        selfReplyPromoIndex: { evidenceFor: () => undefined },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    // bob の評価失敗は alice の評価・completion を巻き込まない。
    expect(result.succeeded).toBe(1)
    expect(recordLabelsSpy).toHaveBeenCalledWith(prisma, {
      sourceKind: 'relabel',
      labels: [
        {
          accountId: 'alice',
          labelDefinitionId: 'def-1',
          method: 'throwing_rule',
          ruleVersion: '1.0.0',
          result: { value: true, confidence: 1, reason: 'test' },
        },
      ],
    })
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-1'],
      leaseOwner: 'test-worker',
    })
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: 'wi-2' },
      data: { lastErrorSummary: expect.stringContaining('broken account data') as string },
    })
  })

  it('1 グループが 25 件を超えると永続化・完了をサブバッチに分割し、1 サブバッチの失敗が他サブバッチの完了済み分を巻き込まない', async () => {
    const rule: LabelRule = {
      key: 'test_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: () => ({ value: true, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    const items = Array.from(
      { length: 30 },
      (_, index) => ({ id: `wi-${index}`, triggerId: `account-${index}` }) as never,
    )
    const accounts = Array.from({ length: 30 }, (_, index) => ({ id: `account-${index}` }))

    const recordLabelsSpy = vi
      .spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts')
      .mockResolvedValue([])
    let completeCallCount = 0
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockImplementation((_prisma, { workItemIds }) => {
        completeCallCount++
        if (completeCallCount === 2) return Promise.reject(new Error('DB write failed'))
        return Promise.resolve(workItemIds.map((id) => ({ id, status: 'succeeded' as const })))
      })
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())
    const updateManySpy = vi.fn().mockResolvedValue({ count: 0 })

    const prisma = makeTransactionalPrisma({
      account: { findMany: vi.fn().mockResolvedValue(accounts) },
      analysisWorkItem: { updateMany: updateManySpy },
    })

    const result = await evaluateAccountRelabelItems(prisma, items, {
      registry,
      labelDefinitionIds: new Map([['test_rule', 'def-1']]),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      bioDuplicateIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: {
        swarmSizeFor: () => 0,
        isEligibleForScreening: () => true,
        evidenceFor: () => undefined,
      },
      followGraphLabelIndex: { signalsFor: () => ({}) },
      selfReplyPromoIndex: { evidenceFor: () => undefined },
      concurrency: 1,
      leaseOwner: 'test-worker',
    })

    // 30 件は 25 件・5 件の 2 サブバッチに分かれ、2 サブバッチ目の失敗は 1 サブバッチ目の 25 件を巻き込まない。
    expect(recordLabelsSpy).toHaveBeenCalledTimes(2)
    expect(completeSpy).toHaveBeenCalledTimes(2)
    expect(result.succeeded).toBe(25)
    expect(updateManySpy).toHaveBeenCalledWith({
      where: {
        id: { in: Array.from({ length: 5 }, (_, index) => `wi-${index + 25}`) },
        status: { not: 'succeeded' },
      },
      data: { lastErrorSummary: expect.stringContaining('DB write failed') as string },
    })
  })

  it('グループの account/tweet 一括取得が失敗しても例外を外に伝播させず、グループ全体を lastErrorSummary 付きで失敗扱いにする', async () => {
    const rule: LabelRule = {
      key: 'test_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: () => ({ value: true, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    const recordLabelsSpy = vi.spyOn(labelRepository, 'recordAccountLabelsBulkForAccounts')
    const completeSpy = vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockRejectedValue(
      new Error('connection reset'),
    )
    const updateManySpy = vi.fn().mockResolvedValue({ count: 0 })

    const prisma = {
      account: { findMany: vi.fn().mockResolvedValue([{ id: 'alice' }, { id: 'bob' }]) },
      analysisWorkItem: { updateMany: updateManySpy },
    } as unknown as PrismaClient

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'alice' } as never, { id: 'wi-2', triggerId: 'bob' } as never],
      {
        registry,
        labelDefinitionIds: new Map([['test_rule', 'def-1']]),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        bioDuplicateIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: {
          swarmSizeFor: () => 0,
          isEligibleForScreening: () => true,
          evidenceFor: () => undefined,
        },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        selfReplyPromoIndex: { evidenceFor: () => undefined },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    expect(result.succeeded).toBe(0)
    expect(recordLabelsSpy).not.toHaveBeenCalled()
    expect(completeSpy).not.toHaveBeenCalled()
    expect(updateManySpy).toHaveBeenCalledWith({
      where: { id: { in: ['wi-1', 'wi-2'] }, status: { not: 'succeeded' } },
      data: { lastErrorSummary: expect.stringContaining('connection reset') as string },
    })
  })
})

describe('scanForStaleAccounts', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('カーソル位置から bounded 件数だけ scan し、stale な account を requestAccountRelabelBulk する', async () => {
    const requestSpy = vi.spyOn(workItemRepository, 'requestAccountRelabelBulk').mockResolvedValue()
    const prisma = {
      relabelScanCursor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastScannedAccountId: null }),
        upsert: vi.fn().mockResolvedValue({}),
      },
      account: {
        findMany: vi.fn().mockResolvedValue([{ id: 'acct-1' }, { id: 'acct-2' }]),
      },
      accountLabelLatest: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { accountId: 'acct-1', labelDefinitionId: 'def-1', ruleVersion: '1.0.0' },
          ]),
      },
    } as unknown as PrismaClient

    const rule: LabelRule = {
      key: 'test_rule',
      description: 'test',
      version: '2.0.0',
      evaluate: () => ({ value: true, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    const result = await scanForStaleAccounts(prisma, {
      registry,
      labelDefinitionIds: new Map([['test_rule', 'def-1']]),
      batchSize: 500,
    })

    expect(result.scanned).toBe(2)
    // acct-1 は ruleVersion が古い (1.0.0 != 2.0.0)、acct-2 は行自体がない → どちらも stale
    expect(requestSpy).toHaveBeenCalledWith(prisma, ['acct-1', 'acct-2'])
    expect(result.requested).toBe(2)
    expect(result.wrapped).toBe(false)
  })

  it('excludeFromStaleScan なルールの version 変更だけでは account を stale 扱いにしない', async () => {
    const requestSpy = vi.spyOn(workItemRepository, 'requestAccountRelabelBulk').mockResolvedValue()
    const findManyCalls: unknown[] = []
    const prisma = {
      relabelScanCursor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastScannedAccountId: null }),
        upsert: vi.fn().mockResolvedValue({}),
      },
      account: {
        findMany: vi.fn().mockResolvedValue([{ id: 'acct-1' }]),
      },
      accountLabelLatest: {
        findMany: vi.fn().mockImplementation((args: unknown) => {
          findManyCalls.push(args)
          // acct-1 は shadow_rule の行を一切持たない (missing ruleVersion) 状態を模す。
          return Promise.resolve([])
        }),
      },
    } as unknown as PrismaClient

    const shadowRule: LabelRule = {
      key: 'shadow_rule',
      description: 'test',
      version: '0.1.0',
      excludeFromStaleScan: true,
      evaluate: () => ({ value: false, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(shadowRule)

    const result = await scanForStaleAccounts(prisma, {
      registry,
      labelDefinitionIds: new Map([['shadow_rule', 'def-shadow']]),
      batchSize: 500,
    })

    expect(result.requested).toBe(0)
    expect(requestSpy).toHaveBeenCalledWith(prisma, [])
    // stale 判定対象のルールが 0 件になるため、AccountLabelLatest 自体を lookup しない。
    expect(findManyCalls).toHaveLength(0)
  })

  it('accountIds が chunk size を超える場合、AccountLabelLatest lookup を chunk ごとに分割し labelDefinitionId でも絞り込む', async () => {
    vi.stubEnv('RELABELER_LABEL_LOOKUP_CHUNK_SIZE', '2')
    vi.spyOn(workItemRepository, 'requestAccountRelabelBulk').mockResolvedValue()
    const findManyCalls: unknown[] = []
    const prisma = {
      relabelScanCursor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastScannedAccountId: null }),
        upsert: vi.fn().mockResolvedValue({}),
      },
      account: {
        findMany: vi.fn().mockResolvedValue([{ id: 'acct-1' }, { id: 'acct-2' }, { id: 'acct-3' }]),
      },
      accountLabelLatest: {
        findMany: vi.fn().mockImplementation((args: unknown) => {
          findManyCalls.push(args)
          return Promise.resolve([])
        }),
      },
    } as unknown as PrismaClient

    const rule: LabelRule = {
      key: 'test_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: () => ({ value: true, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    await scanForStaleAccounts(prisma, {
      registry,
      labelDefinitionIds: new Map([['test_rule', 'def-1']]),
      batchSize: 500,
    })

    // chunk size 2 に対し 3 件の account なので chunk は [acct-1, acct-2] と [acct-3] の2つに分かれる。
    expect(findManyCalls).toHaveLength(2)
    for (const call of findManyCalls) {
      const where = (call as { where: { labelDefinitionId: { in: string[] } } }).where
      expect(where.labelDefinitionId).toEqual({ in: ['def-1'] })
    }
  })
})

function makeCursorPrisma(overrides: Record<string, unknown> = {}): PrismaClient {
  return makeTransactionalPrisma({
    relabelScanCursor: {
      findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastScannedAccountId: null }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    account: { findMany: vi.fn().mockResolvedValue([]) },
    accountLabelLatest: { findMany: vi.fn().mockResolvedValue([]) },
    analysisWorkItem: { update: vi.fn().mockResolvedValue({}) },
    ...overrides,
  })
}

describe('runRelabelWorkerCycleOnce', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(tweetRepository, 'loadRecentTweetsForAccounts').mockResolvedValue(new Map())
    // 個別のテストで上書きしない限り、渡された work item は全て lease を保持し続けている前提にする。
    vi.spyOn(workItemRepository, 'claimStillLeasedWorkItemIdsForUpdate').mockImplementation(
      (_tx, input) => Promise.resolve(input.workItemIds),
    )
    // 個別のテストで上書きしない限り、回収対象の orphan は無い前提にする。
    vi.spyOn(workItemRepository, 'recoverExhaustedExpiredWorkItems').mockResolvedValue({
      reArmed: 0,
      parkedAsFailed: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('recoverExhaustedExpiredWorkItems を peekWorkItemCandidates より先に呼ぶ', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    const callOrder: string[] = []
    vi.spyOn(workItemRepository, 'recoverExhaustedExpiredWorkItems').mockImplementation(() => {
      callOrder.push('recover')
      return Promise.resolve({ reArmed: 0, parkedAsFailed: 0 })
    })
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockImplementation(() => {
      callOrder.push('peek')
      return Promise.resolve([])
    })
    const prisma = makeCursorPrisma()

    await runRelabelWorkerCycleOnce(prisma)

    // stale scan 経由で peek が複数回呼ばれる場合もあるため、recover が最初であることだけを見る。
    expect(callOrder[0]).toBe('recover')
    expect(callOrder.slice(1).every((call) => call === 'peek')).toBe(true)
  })

  it('recover で re-arm した item は同じ cycle の peek 結果に含めて処理できる', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'recoverExhaustedExpiredWorkItems').mockResolvedValue({
      reArmed: 1,
      parkedAsFailed: 0,
    })
    // recover が re-arm した item を peek がそのまま返せることを想定する
    // (実体は analysis-work-item-repository.test.ts の DB テストで検証する)。
    const peekSpy = vi
      .spyOn(workItemRepository, 'peekWorkItemCandidates')
      .mockResolvedValue([{ id: 'wi-recovered', triggerId: 'alice' }])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(bioCorpusModule, 'loadBioCorpus').mockResolvedValue([])
    vi.spyOn(selfReplyPromoCorpusModule, 'loadSelfReplyPromoCorpus').mockResolvedValue({
      selfReplyCorpus: [],
      rootCorpus: [],
    })
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    const claimSpy = vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([])
    const prisma = makeCursorPrisma()

    await runRelabelWorkerCycleOnce(prisma)

    expect(peekSpy).toHaveBeenCalled()
    expect(claimSpy).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ ids: ['wi-recovered'] }),
    )
  })

  it('recoverExhaustedExpiredWorkItems が失敗しても通常の claimable drain は継続する (fail-open)', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'recoverExhaustedExpiredWorkItems').mockRejectedValue(
      new Error('recovery query timeout'),
    )
    const peekSpy = vi
      .spyOn(workItemRepository, 'peekWorkItemCandidates')
      .mockResolvedValue([{ id: 'wi-1', triggerId: 'alice' }])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(bioCorpusModule, 'loadBioCorpus').mockResolvedValue([])
    vi.spyOn(selfReplyPromoCorpusModule, 'loadSelfReplyPromoCorpus').mockResolvedValue({
      selfReplyCorpus: [],
      rootCorpus: [],
    })
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    const claimSpy = vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([])
    const prisma = makeCursorPrisma()

    await runRelabelWorkerCycleOnce(prisma)

    expect(peekSpy).toHaveBeenCalled()
    expect(claimSpy).toHaveBeenCalled()
  })

  it('drain backlog が worker 上限に達している間は stale scan と cursor 更新を行わない', async () => {
    vi.stubEnv('RELABELER_WORKER_BATCH_SIZE', '2')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    const peekSpy = vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(bioCorpusModule, 'loadBioCorpus').mockResolvedValue([])
    vi.spyOn(selfReplyPromoCorpusModule, 'loadSelfReplyPromoCorpus').mockResolvedValue({
      selfReplyCorpus: [],
      rootCorpus: [],
    })
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([])
    const accountFindMany = vi.fn().mockResolvedValue([])
    const cursorUpsert = vi.fn().mockResolvedValue({})
    const prisma = makeCursorPrisma({
      account: { findMany: accountFindMany },
      relabelScanCursor: { findUnique: vi.fn().mockResolvedValue(null), upsert: cursorUpsert },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(peekSpy).toHaveBeenCalledTimes(1)
    expect(accountFindMany).not.toHaveBeenCalled()
    expect(cursorUpsert).not.toHaveBeenCalled()
  })

  it('drain backlog が worker 上限未満の場合だけ stale scan 後に候補を取り直す', async () => {
    vi.stubEnv('RELABELER_WORKER_BATCH_SIZE', '2')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    const peekSpy = vi
      .spyOn(workItemRepository, 'peekWorkItemCandidates')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'wi-1', triggerId: 'alice' }])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(bioCorpusModule, 'loadBioCorpus').mockResolvedValue([])
    vi.spyOn(selfReplyPromoCorpusModule, 'loadSelfReplyPromoCorpus').mockResolvedValue({
      selfReplyCorpus: [],
      rootCorpus: [],
    })
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([])
    const accountFindMany = vi.fn().mockResolvedValue([])
    const cursorUpsert = vi.fn().mockResolvedValue({})
    const prisma = makeCursorPrisma({
      account: { findMany: accountFindMany },
      relabelScanCursor: { findUnique: vi.fn().mockResolvedValue(null), upsert: cursorUpsert },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(peekSpy).toHaveBeenCalledTimes(2)
    expect(accountFindMany).toHaveBeenCalled()
    expect(cursorUpsert).not.toHaveBeenCalled()
  })

  it('peek 候補が 0 件の場合、buildFollowGraphLabelIndex・loadReplyCorpus・claim を一切行わない', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    const peekSpy = vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([])
    const claimSpy = vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds')
    const followGraphSpy = vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex')
    const replyCorpusSpy = vi.spyOn(replyCorpusModule, 'loadReplyCorpus')
    const bioCorpusSpy = vi.spyOn(bioCorpusModule, 'loadBioCorpus')
    const prisma = makeCursorPrisma()

    await runRelabelWorkerCycleOnce(prisma)

    expect(peekSpy).toHaveBeenCalled()
    expect(claimSpy).not.toHaveBeenCalled()
    expect(followGraphSpy).not.toHaveBeenCalled()
    expect(replyCorpusSpy).not.toHaveBeenCalled()
    expect(bioCorpusSpy).not.toHaveBeenCalled()
  })

  it('buildFollowGraphLabelIndex には peek した全 accountId を1回だけ渡し、usesFollowGraphSignal を持つルールのラベルだけを渡す', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(
      new Map([
        ['topic_anime', 'ld-follow'],
        ['ad_pr_hashtag', 'ld-no-follow'],
      ]),
    )
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' } as never,
      { id: 'wi-2', triggerId: 'bob' } as never,
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(bioCorpusModule, 'loadBioCorpus').mockResolvedValue([])
    vi.spyOn(selfReplyPromoCorpusModule, 'loadSelfReplyPromoCorpus').mockResolvedValue({
      selfReplyCorpus: [],
      rootCorpus: [],
    })
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockResolvedValue([])
    const followGraphSpy = vi
      .spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex')
      .mockResolvedValue({ signalsFor: () => ({}) })
    const prisma = makeCursorPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(followGraphSpy).toHaveBeenCalledTimes(1)
    expect(followGraphSpy).toHaveBeenCalledWith(prisma, new Map([['topic_anime', 'ld-follow']]), {
      accountIds: ['alice', 'bob'],
      chunkSize: 1000,
    })
  })

  it('account/follow データ変更による通常の account_relabel は、follow-graph ルールの ruleVersion が最新でも follow-graph index の対象から除外しない', async () => {
    // alice は account_relabel を要求されているが、follow-graph ルールの ruleVersion は
    // 既に最新 (= stale scan 由来ではなく account/follow データ変更由来の可能性がある)。
    // ruleVersion 一致だけを根拠に follow-graph index 構築対象から除外すると、
    // 変化した follow グラフを無視して空の signal で再評価してしまう。
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(
      new Map([['topic_anime', 'ld-follow']]),
    )
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
    ])
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' } as never,
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(bioCorpusModule, 'loadBioCorpus').mockResolvedValue([])
    vi.spyOn(selfReplyPromoCorpusModule, 'loadSelfReplyPromoCorpus').mockResolvedValue({
      selfReplyCorpus: [],
      rootCorpus: [],
    })
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockResolvedValue([])
    const followGraphSpy = vi
      .spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex')
      .mockResolvedValue({ signalsFor: () => ({}) })
    const prisma = makeCursorPrisma({
      account: { findMany: vi.fn().mockResolvedValue([]) },
      accountLabelLatest: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { accountId: 'alice', labelDefinitionId: 'ld-follow', ruleVersion: '999.0.0' },
          ]),
      },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(followGraphSpy).toHaveBeenCalledWith(prisma, new Map([['topic_anime', 'ld-follow']]), {
      accountIds: ['alice'],
      chunkSize: 1000,
    })
  })

  it('index 構築が候補確定後・claim 前に失敗した場合、1 件も claim されず lastErrorSummary も書かれない', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
    ])
    const claimSpy = vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds')
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockRejectedValue(new Error('db timeout'))
    const updateSpy = vi.fn().mockResolvedValue({})
    const prisma = makeCursorPrisma({ analysisWorkItem: { update: updateSpy } })

    await expect(runRelabelWorkerCycleOnce(prisma)).rejects.toThrow('db timeout')

    expect(claimSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('peek した WorkItem id 集合だけを RELABELER_WORKER_CHUNK_SIZE ごとの chunk で claim し、候補外を補充しない', async () => {
    vi.stubEnv('RELABELER_WORKER_CHUNK_SIZE', '2')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
      { id: 'wi-3', triggerId: 'carol' },
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(bioCorpusModule, 'loadBioCorpus').mockResolvedValue([])
    vi.spyOn(selfReplyPromoCorpusModule, 'loadSelfReplyPromoCorpus').mockResolvedValue({
      selfReplyCorpus: [],
      rootCorpus: [],
    })
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockImplementation(
      (_prisma, { workItemIds }) =>
        Promise.resolve(workItemIds.map((id) => ({ id, status: 'succeeded' as const }))),
    )
    const claimSpy = vi
      .spyOn(workItemRepository, 'claimWorkItemBatchByIds')
      .mockImplementation((_prisma, { ids }) =>
        Promise.resolve(ids.map((id) => ({ id, triggerId: `t-${id}` }) as never)),
      )
    const prisma = makeCursorPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(claimSpy).toHaveBeenCalledTimes(2)
    expect(claimSpy).toHaveBeenNthCalledWith(
      1,
      prisma,
      expect.objectContaining({ ids: ['wi-1', 'wi-2'] }),
    )
    expect(claimSpy).toHaveBeenNthCalledWith(2, prisma, expect.objectContaining({ ids: ['wi-3'] }))
  })

  it('競合で一部の候補が claim できなかった場合、その分を他の WorkItem で補充しない', async () => {
    vi.stubEnv('RELABELER_WORKER_CHUNK_SIZE', '2')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(bioCorpusModule, 'loadBioCorpus').mockResolvedValue([])
    vi.spyOn(selfReplyPromoCorpusModule, 'loadSelfReplyPromoCorpus').mockResolvedValue({
      selfReplyCorpus: [],
      rootCorpus: [],
    })
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockResolvedValue([{ id: 'wi-1', status: 'succeeded' }])
    // wi-2 は別ワーカーとの競合で SKIP LOCKED により claim できなかったことを模す。
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' } as never,
    ])
    const prisma = makeCursorPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    })

    await runRelabelWorkerCycleOnce(prisma)

    expect(completeSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-1'],
      leaseOwner: expect.any(String),
    })
  })

  it('自己フィードバック防止: chunk A の評価後も chunk B の評価には同じ followGraphLabelIndex インスタンスを使う', async () => {
    vi.stubEnv('RELABELER_WORKER_CHUNK_SIZE', '1')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(bioCorpusModule, 'loadBioCorpus').mockResolvedValue([])
    vi.spyOn(selfReplyPromoCorpusModule, 'loadSelfReplyPromoCorpus').mockResolvedValue({
      selfReplyCorpus: [],
      rootCorpus: [],
    })
    const sharedIndex = { signalsFor: () => ({}) }
    const followGraphSpy = vi
      .spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex')
      .mockResolvedValue(sharedIndex)
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk').mockImplementation(
      (_prisma, { workItemIds }) =>
        Promise.resolve(workItemIds.map((id) => ({ id, status: 'succeeded' as const }))),
    )
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds').mockImplementation((_prisma, { ids }) =>
      Promise.resolve(
        ids.map((id) => ({ id, triggerId: id === 'wi-1' ? 'alice' : 'bob' }) as never),
      ),
    )
    const accountFindMany = vi.fn().mockResolvedValue([])
    const prisma = makeCursorPrisma({
      account: { findMany: accountFindMany },
    })

    await runRelabelWorkerCycleOnce(prisma)

    // followGraphLabelIndex は cycle 全体で1回しか構築されず、2 chunk とも同じインスタンスを参照する。
    expect(followGraphSpy).toHaveBeenCalledTimes(1)
  })

  it('2 chunk 目の claim が失敗した場合、1 chunk 目は complete 済みのまま例外を再送出する (blast radius は chunk size 以下)', async () => {
    vi.stubEnv('RELABELER_WORKER_CHUNK_SIZE', '1')
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'peekWorkItemCandidates').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(bioCorpusModule, 'loadBioCorpus').mockResolvedValue([])
    vi.spyOn(selfReplyPromoCorpusModule, 'loadSelfReplyPromoCorpus').mockResolvedValue({
      selfReplyCorpus: [],
      rootCorpus: [],
    })
    vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex').mockResolvedValue({
      signalsFor: () => ({}),
    })
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItemsBulk')
      .mockResolvedValue([{ id: 'wi-1', status: 'succeeded' }])
    vi.spyOn(workItemRepository, 'claimWorkItemBatchByIds')
      .mockResolvedValueOnce([{ id: 'wi-1', triggerId: 'alice' } as never])
      .mockRejectedValueOnce(new Error('claim crashed'))
    const prisma = makeCursorPrisma({
      account: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    })

    await expect(runRelabelWorkerCycleOnce(prisma)).rejects.toThrow('claim crashed')

    // wi-2 は claim 自体が失敗しており lease されていないため、書き残す lastErrorSummary は無い。
    // 1 chunk 目 (wi-1) は既に complete 済みで、2 chunk 目の失敗による影響を受けない。
    expect(completeSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemIds: ['wi-1'],
      leaseOwner: expect.any(String),
    })
  })
})
