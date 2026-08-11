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
  it('batchSize を上限に work item を claim する', async () => {
    vi.spyOn(workItemRepository, 'claimNextWorkItem')
      .mockResolvedValueOnce({ id: 'wi-1', triggerId: 'alice' } as never)
      .mockResolvedValueOnce({ id: 'wi-2', triggerId: 'bob' } as never)
      .mockResolvedValueOnce(undefined)

    const items = await claimAccountRelabelBatch({} as PrismaClient, {
      batchSize: 10,
      leaseOwner: 'test-worker',
    })

    expect(items).toHaveLength(2)
    expect(items.map((item) => item.triggerId)).toEqual(['alice', 'bob'])
  })

  it('claim できる件数が batchSize 未満でも、claim できなくなった時点で打ち切る', async () => {
    vi.spyOn(workItemRepository, 'claimNextWorkItem').mockResolvedValueOnce(undefined)

    const items = await claimAccountRelabelBatch({} as PrismaClient, {
      batchSize: 5,
      leaseOwner: 'test-worker',
    })

    expect(items).toHaveLength(0)
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
    const findUniqueOrder: string[] = []
    const prisma = {
      account: {
        findUnique: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          findUniqueOrder.push(where.id)
          return Promise.resolve({ id: where.id })
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

    const result = await evaluateAccountRelabelItems(prisma, items, {
      registry: new LabelRuleRegistry(),
      labelDefinitionIds: new Map(),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
      followGraphLabelIndex: { signalsFor: () => ({}) },
      concurrency: 2,
      leaseOwner: 'test-worker',
    })

    expect(result.succeeded).toBe(4)
    expect(new Set(findUniqueOrder)).toEqual(new Set(['alice', 'bob', 'carol', 'dave']))
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
    vi.spyOn(workItemRepository, 'claimNextWorkItem').mockResolvedValue(undefined)
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
})
