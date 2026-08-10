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

    const result = await drainAccountRelabelQueue(prisma, {
      registry,
      labelDefinitionIds: new Map([['test_rule', 'def-1']]),
      duplicateReplyIndex: { countOtherAccounts: () => 0 },
      replyHijackIndex: { swarmSizeFor: () => 0 },
      followGraphLabelIndex: { signalsFor: () => ({}) },
      batchSize: 10,
      leaseOwner: 'test-worker',
    })

    expect(result.claimed).toBe(1)
    expect(result.succeeded).toBe(1)
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
      replyHijackIndex: { swarmSizeFor: () => 0 },
      followGraphLabelIndex: { signalsFor: () => ({}) },
      batchSize: 10,
      leaseOwner: 'test-worker',
    })

    expect(result.succeeded).toBe(1)
    expect(completeSpy).toHaveBeenCalled()
  })
})

describe('scanForStaleAccounts', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('カーソル位置から bounded 件数だけ scan し、stale な account を requestAccountRelabel する', async () => {
    const requestSpy = vi.spyOn(workItemRepository, 'requestAccountRelabel').mockResolvedValue()
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
    expect(requestSpy).toHaveBeenCalledWith(prisma, 'acct-1')
    expect(requestSpy).toHaveBeenCalledWith(prisma, 'acct-2')
    expect(result.requested).toBe(2)
  })
})
