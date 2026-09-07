import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { LabelRule } from '../labels/types'
import {
  ensureLabelDefinition,
  ensureLabelDefinitionsForRules,
  filterAccountIdsWithExistingLabels,
  recordAccountLabelsBulkLatestOnlyForAccounts,
  recordCrawlAccountLabelsAtomic,
  recordCrawlAccountLabelsAtomicWithinTx,
} from './label-repository'

vi.mock('node:crypto', () => ({ randomUUID: () => 'mock-id' }))

describe('ensureLabelDefinition', () => {
  it('upserts by key', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'ld1', key: 'blue_verified' })
    const prisma = { labelDefinition: { upsert } } as unknown as PrismaClient

    await ensureLabelDefinition(prisma, {
      key: 'blue_verified',
      description: 'desc',
      currentRuleVersion: '1.0.0',
    })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.where).toEqual({ key: 'blue_verified' })
  })

  it('既存の LabelDefinition の currentRuleVersion を更新する', async () => {
    const upsertMock = vi.fn().mockResolvedValue({
      id: 'def-1',
      key: 'blue_verified',
      description: 'desc',
      currentRuleVersion: '2.0.0',
      createdAt: new Date(),
    })
    const prisma = { labelDefinition: { upsert: upsertMock } } as unknown as PrismaClient

    await ensureLabelDefinition(prisma, {
      key: 'blue_verified',
      description: 'desc',
      currentRuleVersion: '2.0.0',
    })

    expect(upsertMock).toHaveBeenCalledWith({
      where: { key: 'blue_verified' },
      create: { key: 'blue_verified', description: 'desc', currentRuleVersion: '2.0.0' },
      update: { description: 'desc', currentRuleVersion: '2.0.0' },
    })
  })
})

describe('ensureLabelDefinitionsForRules', () => {
  it('ensures a LabelDefinition for every rule and maps each key to its id', async () => {
    const upsert = vi
      .fn()
      .mockImplementation(({ create }: { create: { key: string } }) =>
        Promise.resolve({ id: `ld-${create.key}`, key: create.key }),
      )
    const prisma = { labelDefinition: { upsert } } as unknown as PrismaClient

    const rules: LabelRule[] = [
      {
        key: 'blue_verified',
        description: 'a',
        version: '1.0.0',
        evaluate: () => ({ value: true, confidence: 1, reason: '' }),
      },
      {
        key: 'spam',
        description: 'b',
        version: '1.0.0',
        evaluate: () => ({ value: false, confidence: 0, reason: '' }),
      },
    ]

    const result = await ensureLabelDefinitionsForRules(prisma, rules)

    expect(upsert).toHaveBeenCalledTimes(2)
    expect(result.get('blue_verified')).toBe('ld-blue_verified')
    expect(result.get('spam')).toBe('ld-spam')
  })
})

describe('recordAccountLabelsBulkLatestOnlyForAccounts', () => {
  it('orders Phase B latest-only UPSERT input by accountId and labelDefinitionId before taking row locks', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0)
    const prisma = { $executeRaw: executeRaw } as unknown as PrismaClient

    await recordAccountLabelsBulkLatestOnlyForAccounts(prisma, {
      sourceKind: 'relabel',
      labels: [
        {
          accountId: 'account-b',
          labelDefinitionId: 'label-a',
          result: { value: true, confidence: 1, reason: 'b-a' },
          method: 'rule',
          ruleVersion: 'v1',
        },
        {
          accountId: 'account-a',
          labelDefinitionId: 'label-z',
          result: { value: true, confidence: 1, reason: 'a-z' },
          method: 'rule',
          ruleVersion: 'v1',
        },
        {
          accountId: 'account-a',
          labelDefinitionId: 'label-a',
          result: { value: true, confidence: 1, reason: 'a-a' },
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    })

    const [, ...values] = executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(values[0]).toEqual(['account-a', 'account-a', 'account-b'])
    expect(values[1]).toEqual(['label-a', 'label-z', 'label-a'])
  })
})

describe('recordCrawlAccountLabelsAtomicWithinTx', () => {
  it('claims labels, persists via the AccountLabelLatest-only writer (no raw AccountLabel INSERT), and returns an observation id without opening its own transaction', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ labelDefinitionId: 'ld1', method: 'rule', ruleVersion: 'v1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          labelDefinitionId: 'ld1',
          value: true,
          confidence: 1,
          reason: 'test',
          method: 'rule',
          ruleVersion: 'v1',
          evaluable: true,
          labeledAt: new Date('2026-08-04T00:00:00Z'),
        },
      ])
    const executeRaw = vi.fn().mockResolvedValue(0)
    const create = vi.fn().mockResolvedValue({ id: 'observation1' })
    const upsert = vi.fn().mockResolvedValue({})
    const txClient = {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
      accountClassificationObservation: { create },
      analysisWorkItem: { upsert },
    } as unknown as PrismaClient

    const observationId = await recordCrawlAccountLabelsAtomicWithinTx(txClient, {
      accountId: 'u1',
      crawlRunId: 'crawl-1',
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: 'ld1',
          result: { value: true, confidence: 1, reason: 'test' },
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    })

    expect(observationId).toBe('observation1')
    // claim → FOR UPDATE lock → snapshot 再読込 の3回のみ。history INSERT が
    // recordAccountLabelsBulkLatestOnlyForAccounts (executeRaw) 側に移り、
    // queryRaw からは raw AccountLabel INSERT を含む呼び出しが消える。
    expect(queryRaw).toHaveBeenCalledTimes(3)
    const preLockSql = queryRaw.mock.calls[1]?.[0]
    expect(String(preLockSql)).toContain('FOR UPDATE')
    const snapshotReadSql = queryRaw.mock.calls[2]?.[0]
    expect(String(snapshotReadSql)).toContain('FOR UPDATE')
    for (const call of queryRaw.mock.calls) {
      expect(String(call[0])).not.toContain('INSERT INTO "AccountLabel"')
    }
    expect(executeRaw).toHaveBeenCalledTimes(1)
    const latestOnlyWriteSql = executeRaw.mock.calls[0]?.[0]
    expect(String(latestOnlyWriteSql)).toContain('INSERT INTO "AccountLabelLatest"')
    expect(String(latestOnlyWriteSql)).not.toContain('INSERT INTO "AccountLabel"')
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        snapshotVersion: 1,
        classificationSnapshot: [
          {
            labelDefinitionId: 'ld1',
            value: true,
            confidence: 1,
            reason: 'test',
            method: 'rule',
            ruleVersion: 'v1',
            evaluable: true,
            labeledAt: '2026-08-04T00:00:00.000Z',
          },
        ],
      }),
    })
  })

  it('returns null without creating an observation when there are no labels', async () => {
    const txClient = { $queryRaw: vi.fn() } as unknown as PrismaClient

    const observationId = await recordCrawlAccountLabelsAtomicWithinTx(txClient, {
      accountId: 'u1',
      crawlRunId: 'crawl-1',
      username: 'login_account',
      labels: [],
    })

    expect(observationId).toBeNull()
  })
})

describe('recordCrawlAccountLabelsAtomic transaction budget', () => {
  it('extends the transaction timeout beyond the Prisma default', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) }
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx))
    const prisma = { $transaction: transaction } as unknown as PrismaClient

    await recordCrawlAccountLabelsAtomic(prisma, {
      accountId: 'u1',
      crawlRunId: 'crawl-1',
      username: 'login_account',
      labels: [
        {
          labelDefinitionId: 'ld1',
          result: { value: true, confidence: 1, reason: 'test' },
          method: 'rule',
          ruleVersion: 'v1',
        },
      ],
    })

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 15_000,
      timeout: 15_000,
    })
  })
})

describe('filterAccountIdsWithExistingLabels', () => {
  it('AccountLabelLatest に行がある accountId だけを返す', async () => {
    const findMany = vi.fn().mockResolvedValue([{ accountId: 'acct-1' }, { accountId: 'acct-3' }])
    const prisma = { accountLabelLatest: { findMany } } as unknown as PrismaClient

    const result = await filterAccountIdsWithExistingLabels(prisma, ['acct-1', 'acct-2', 'acct-3'])

    expect(result).toEqual(new Set(['acct-1', 'acct-3']))
  })

  it('空配列を渡した場合はクエリを発行せず空集合を返す', async () => {
    const findMany = vi.fn()
    const prisma = { accountLabelLatest: { findMany } } as unknown as PrismaClient

    const result = await filterAccountIdsWithExistingLabels(prisma, [])

    expect(result).toEqual(new Set())
    expect(findMany).not.toHaveBeenCalled()
  })
})
