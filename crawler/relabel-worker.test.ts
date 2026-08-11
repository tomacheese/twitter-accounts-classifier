import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import { LabelRuleRegistry } from './labels/registry'
import type { LabelRule } from './labels/types'
import * as workItemRepository from './db/analysis-work-item-repository'
import * as labelRepository from './db/label-repository'
import * as followGraphIndexModule from './labels/follow-graph-label-index'
import * as replyCorpusModule from './db/reply-corpus'
import {
  claimAccountRelabelBatch,
  evaluateAccountRelabelItems,
  runRelabelWorkerCycleOnce,
  scanForStaleAccounts,
} from './relabel-worker'

describe('claimAccountRelabelBatch', () => {
  it('batchSize 件を 1 回の DB roundtrip で claim する', async () => {
    const first = { id: 'wi-1', triggerId: 'alice' } as never
    const second = { id: 'wi-2', triggerId: 'bob' } as never
    const queryRaw = vi.fn().mockResolvedValue([first, second])
    const transaction = vi.fn()
    const prisma = { $queryRaw: queryRaw, $transaction: transaction } as unknown as PrismaClient

    const items = await claimAccountRelabelBatch(prisma, {
      batchSize: 10,
      leaseOwner: 'test-worker',
    })

    expect(items.map((item) => item.triggerId)).toEqual(['alice', 'bob'])
    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('claim 対象がない場合は空配列を返す', async () => {
    const claimSpy = vi.spyOn(workItemRepository, 'claimWorkItemBatch').mockResolvedValue([])
    const prisma = {} as PrismaClient

    const items = await claimAccountRelabelBatch(prisma, {
      batchSize: 5,
      leaseOwner: 'test-worker',
    })

    expect(items).toEqual([])
    expect(claimSpy).toHaveBeenCalledWith(prisma, {
      kinds: ['account_relabel'],
      batchSize: 5,
      leaseOwner: 'test-worker',
      leaseDurationMs: 5 * 60 * 1000,
    })
  })
})

describe('evaluateAccountRelabelItems', () => {
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
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItem')
      .mockResolvedValue('succeeded')
    const recordLabelsSpy = vi
      .spyOn(labelRepository, 'recordAccountLabelsBulk')
      .mockResolvedValue([])

    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue({ id: 'alice' }) },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'alice' } as never],
      {
        registry,
        labelDefinitionIds: new Map([['test_rule', 'def-1']]),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    expect(result.succeeded).toBe(1)
    expect(recordLabelsSpy).toHaveBeenCalledWith(prisma, {
      accountId: 'alice',
      sourceKind: 'relabel',
      labels: [
        {
          labelDefinitionId: 'def-1',
          method: 'test_rule',
          ruleVersion: '1.0.0',
          result: { value: true, confidence: 1, reason: 'test' },
        },
      ],
    })
    expect(completeSpy).toHaveBeenCalledWith(prisma, {
      workItemId: 'wi-1',
      leaseOwner: 'test-worker',
    })
  })

  it('account が既に削除されている場合は評価をスキップして succeeded 扱いにする', async () => {
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItem')
      .mockResolvedValue('succeeded')

    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(null) },
      tweet: { findMany: vi.fn() },
    } as unknown as PrismaClient

    const result = await evaluateAccountRelabelItems(
      prisma,
      [{ id: 'wi-1', triggerId: 'deleted-account' } as never],
      {
        registry: new LabelRuleRegistry(),
        labelDefinitionIds: new Map(),
        duplicateReplyIndex: { countOtherAccounts: () => 0 },
        replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
        followGraphLabelIndex: { signalsFor: () => ({}) },
        concurrency: 1,
        leaseOwner: 'test-worker',
      },
    )

    expect(result.succeeded).toBe(1)
    expect(completeSpy).toHaveBeenCalled()
  })

  it('concurrency を 2 以上に設定すると複数チャンクへ分割して並走する', async () => {
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItem').mockResolvedValue('succeeded')
    vi.spyOn(labelRepository, 'recordAccountLabelsBulk').mockResolvedValue([])
    const pendingResolvers: (() => void)[] = []
    const prisma = {
      account: {
        findUnique: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          return new Promise((resolve) => {
            pendingResolvers.push(() => {
              resolve({ id: where.id })
            })
          })
        }),
      },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient

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
      replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
      followGraphLabelIndex: { signalsFor: () => ({}) },
      concurrency: 2,
      leaseOwner: 'test-worker',
    })

    // concurrency: 2 なら chunk (alice→carol) と chunk (bob→dave) が同時に走り出すため、
    // 両チャンク先頭の findUnique が解決前に 2 件同時に保留する。concurrency: 1 の直列実行では
    // この時点で保留は 1 件にしかならないため、この件数がチャンク並走の検証点になる。
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
})

describe('scanForStaleAccounts', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
})

describe('runRelabelWorkerCycleOnce', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('claim 件数が 0 件の cycle では buildFollowGraphLabelIndex・loadReplyCorpus を呼ばない', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'claimWorkItemBatch').mockResolvedValue([])
    const followGraphSpy = vi.spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex')
    const replyCorpusSpy = vi.spyOn(replyCorpusModule, 'loadReplyCorpus')
    const prisma = {
      relabelScanCursor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastScannedAccountId: null }),
        upsert: vi.fn().mockResolvedValue({}),
      },
      account: { findMany: vi.fn().mockResolvedValue([]) },
      accountLabelLatest: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient

    await runRelabelWorkerCycleOnce(prisma)

    expect(followGraphSpy).not.toHaveBeenCalled()
    expect(replyCorpusSpy).not.toHaveBeenCalled()
  })

  it('buildFollowGraphLabelIndex には usesFollowGraphSignal を持つルールのラベルだけを渡す', async () => {
    // フィルタ後も残ることを検証するため、実際に usesFollowGraphSignal: true を持つルールの key を使う。
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(
      new Map([
        ['topic_anime', 'ld-follow'],
        ['ad_pr_hashtag', 'ld-no-follow'],
      ]),
    )
    vi.spyOn(workItemRepository, 'claimWorkItemBatch').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' } as never,
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockResolvedValue([])
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItem').mockResolvedValue('succeeded')
    const followGraphSpy = vi
      .spyOn(followGraphIndexModule, 'buildFollowGraphLabelIndex')
      .mockResolvedValue({ signalsFor: () => ({}) })
    const prisma = {
      relabelScanCursor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastScannedAccountId: null }),
        upsert: vi.fn().mockResolvedValue({}),
      },
      account: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      accountLabelLatest: { findMany: vi.fn().mockResolvedValue([]) },
      analysisWorkItem: { update: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient

    await runRelabelWorkerCycleOnce(prisma)

    expect(followGraphSpy).toHaveBeenCalledWith(prisma, new Map([['topic_anime', 'ld-follow']]), {
      accountIds: ['alice'],
    })
  })

  it('index 構築が失敗した場合、claim 済みの item に lastErrorSummary を書き残して例外を再送出する', async () => {
    vi.spyOn(labelRepository, 'ensureLabelDefinitionsForRules').mockResolvedValue(new Map())
    vi.spyOn(workItemRepository, 'claimWorkItemBatch').mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' } as never,
    ])
    vi.spyOn(replyCorpusModule, 'loadReplyCorpus').mockRejectedValue(new Error('db timeout'))
    const updateSpy = vi.fn().mockResolvedValue({})
    const prisma = {
      relabelScanCursor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastScannedAccountId: null }),
        upsert: vi.fn().mockResolvedValue({}),
      },
      account: { findMany: vi.fn().mockResolvedValue([]) },
      accountLabelLatest: { findMany: vi.fn().mockResolvedValue([]) },
      analysisWorkItem: { update: updateSpy },
    } as unknown as PrismaClient

    await expect(runRelabelWorkerCycleOnce(prisma)).rejects.toThrow('db timeout')

    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: 'wi-1' },
      data: { lastErrorSummary: expect.stringContaining('db timeout') },
    })
  })
})
