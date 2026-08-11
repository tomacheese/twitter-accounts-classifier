import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import { LabelRuleRegistry } from './labels/registry'
import type { LabelRule } from './labels/types'
import * as workItemRepository from './db/analysis-work-item-repository'
import * as labelRepository from './db/label-repository'
import { drainAccountRelabelQueue, scanForStaleAccounts } from './relabel-worker'

describe('drainAccountRelabelQueue', () => {
  it('claim できた work item を評価・complete まで処理する', async () => {
    const rule: LabelRule = {
      key: 'test_rule',
      description: 'test',
      version: '1.0.0',
      evaluate: () => ({ value: true, confidence: 1, reason: 'test' }),
    }
    const registry = new LabelRuleRegistry()
    registry.register(rule)

    vi.spyOn(workItemRepository, 'claimNextWorkItem')
      .mockResolvedValueOnce({
        id: 'wi-1',
        triggerId: 'acct-1',
      } as never)
      .mockResolvedValueOnce(undefined)
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItem')
      .mockResolvedValue('succeeded')
    const recordLabelsSpy = vi
      .spyOn(labelRepository, 'recordAccountLabelsBulk')
      .mockResolvedValue([])

    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue({ id: 'acct-1' }) },
      tweet: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient
    const buildFollowGraphLabelIndex = vi.fn().mockResolvedValue({ signalsFor: () => ({}) })

    const result = await drainAccountRelabelQueue(prisma, {
      registry,
      labelDefinitionIds: new Map([['test_rule', 'def-1']]),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
      buildFollowGraphLabelIndex,
      batchSize: 10,
      leaseOwner: 'test-worker',
    })

    expect(result.claimed).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(buildFollowGraphLabelIndex).toHaveBeenCalledWith(['acct-1'])
    expect(recordLabelsSpy).toHaveBeenCalledWith(prisma, {
      accountId: 'acct-1',
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
    vi.spyOn(workItemRepository, 'claimNextWorkItem')
      .mockResolvedValueOnce({ id: 'wi-1', triggerId: 'acct-deleted' } as never)
      .mockResolvedValueOnce(undefined)
    const completeSpy = vi
      .spyOn(workItemRepository, 'completeAccountRelabelWorkItem')
      .mockResolvedValue('succeeded')

    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(null) },
      tweet: { findMany: vi.fn() },
    } as unknown as PrismaClient

    const result = await drainAccountRelabelQueue(prisma, {
      registry: new LabelRuleRegistry(),
      labelDefinitionIds: new Map(),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
      buildFollowGraphLabelIndex: vi.fn().mockResolvedValue({ signalsFor: () => ({}) }),
      batchSize: 10,
      leaseOwner: 'test-worker',
    })

    expect(result.succeeded).toBe(1)
    expect(completeSpy).toHaveBeenCalled()
  })

  it('claim できる work item が無い場合は buildFollowGraphLabelIndex を呼ばない', async () => {
    vi.spyOn(workItemRepository, 'claimNextWorkItem').mockResolvedValueOnce(undefined)
    const buildFollowGraphLabelIndex = vi.fn().mockResolvedValue({ signalsFor: () => ({}) })

    const prisma = {} as unknown as PrismaClient

    const result = await drainAccountRelabelQueue(prisma, {
      registry: new LabelRuleRegistry(),
      labelDefinitionIds: new Map(),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
      buildFollowGraphLabelIndex,
      batchSize: 10,
      leaseOwner: 'test-worker',
    })

    expect(result.claimed).toBe(0)
    expect(buildFollowGraphLabelIndex).not.toHaveBeenCalled()
  })

  it('claim した複数 work item の accountId をまとめて buildFollowGraphLabelIndex に渡す', async () => {
    vi.spyOn(workItemRepository, 'claimNextWorkItem')
      .mockResolvedValueOnce({ id: 'wi-1', triggerId: 'acct-1' } as never)
      .mockResolvedValueOnce({ id: 'wi-2', triggerId: 'acct-2' } as never)
      .mockResolvedValueOnce(undefined)
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItem').mockResolvedValue('succeeded')
    const buildFollowGraphLabelIndex = vi.fn().mockResolvedValue({ signalsFor: () => ({}) })

    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(null) },
      tweet: { findMany: vi.fn() },
    } as unknown as PrismaClient

    await drainAccountRelabelQueue(prisma, {
      registry: new LabelRuleRegistry(),
      labelDefinitionIds: new Map(),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
      buildFollowGraphLabelIndex,
      batchSize: 10,
      leaseOwner: 'test-worker',
    })

    expect(buildFollowGraphLabelIndex).toHaveBeenCalledTimes(1)
    expect(buildFollowGraphLabelIndex).toHaveBeenCalledWith(['acct-1', 'acct-2'])
  })

  it('claim 件数が chunk サイズを超える場合、chunk ごとに buildFollowGraphLabelIndex を呼ぶ', async () => {
    const totalItems = 101
    let callCount = 0
    vi.spyOn(workItemRepository, 'claimNextWorkItem').mockImplementation(() => {
      if (callCount >= totalItems) return Promise.resolve(undefined)
      callCount++
      return { id: `wi-${callCount}`, triggerId: `acct-${callCount}` } as never
    })
    vi.spyOn(workItemRepository, 'completeAccountRelabelWorkItem').mockResolvedValue('succeeded')
    const buildFollowGraphLabelIndex = vi.fn().mockResolvedValue({ signalsFor: () => ({}) })

    const prisma = {
      account: { findUnique: vi.fn().mockResolvedValue(null) },
      tweet: { findMany: vi.fn() },
    } as unknown as PrismaClient

    const result = await drainAccountRelabelQueue(prisma, {
      registry: new LabelRuleRegistry(),
      labelDefinitionIds: new Map(),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
      buildFollowGraphLabelIndex,
      batchSize: totalItems,
      leaseOwner: 'test-worker',
    })

    expect(result.claimed).toBe(totalItems)
    expect(buildFollowGraphLabelIndex).toHaveBeenCalledTimes(2)
    expect((buildFollowGraphLabelIndex.mock.calls[0][0] as string[]).length).toBe(100)
    expect((buildFollowGraphLabelIndex.mock.calls[1][0] as string[]).length).toBe(1)
  })

  it('buildFollowGraphLabelIndex が失敗した場合、chunk 内の item に lastErrorSummary を記録し drain を中断する', async () => {
    // claim 可能な item がまだ多数残っている状況でも、以降の chunk を試行しないことを検証する。
    let callCount = 0
    vi.spyOn(workItemRepository, 'claimNextWorkItem').mockImplementation(() => {
      callCount++
      return Promise.resolve({ id: `wi-${callCount}`, triggerId: `acct-${callCount}` } as never)
    })
    const updateSpy = vi.fn().mockResolvedValue(undefined)
    const buildFollowGraphLabelIndex = vi.fn().mockRejectedValue(new Error('index build failed'))

    const prisma = {
      account: { findUnique: vi.fn() },
      tweet: { findMany: vi.fn() },
      analysisWorkItem: { update: updateSpy },
    } as unknown as PrismaClient

    const result = await drainAccountRelabelQueue(prisma, {
      registry: new LabelRuleRegistry(),
      labelDefinitionIds: new Map(),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: { swarmSizeFor: () => 0, isEligibleForScreening: () => true },
      buildFollowGraphLabelIndex,
      batchSize: 250,
      leaseOwner: 'test-worker',
    })

    expect(result.claimed).toBe(100)
    expect(result.succeeded).toBe(0)
    expect(buildFollowGraphLabelIndex).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledTimes(100)
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: 'wi-1' },
      data: { lastErrorSummary: expect.stringContaining('index build failed') },
    })
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
