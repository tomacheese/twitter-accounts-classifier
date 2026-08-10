import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { LabelRule } from '../labels/types'
import {
  ensureLabelDefinition,
  ensureLabelDefinitionsForRules,
  recordAccountLabelsBulk,
  recordCrawlAccountLabel,
  recordCrawlAccountLabelsAtomic,
  recordCrawlAccountLabelsAtomicWithinTx,
} from './label-repository'

vi.mock('node:crypto', () => ({ randomUUID: () => 'mock-id' }))

describe('ensureLabelDefinition', () => {
  it('upserts by key', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'ld1', key: 'blue_verified' })
    const prisma = { labelDefinition: { upsert } } as unknown as PrismaClient

    await ensureLabelDefinition(prisma, { key: 'blue_verified', description: 'desc' })

    const call = upsert.mock.calls[0][0] as Record<string, unknown>
    expect(call.where).toEqual({ key: 'blue_verified' })
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

describe('recordAccountLabelsBulk', () => {
  it('does not call queryRaw when there are no labels to persist', async () => {
    const queryRaw = vi.fn()
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await recordAccountLabelsBulk(prisma, {
      sourceKind: 'relabel',
      accountId: 'u1',
      labels: [],
    })

    expect(result).toEqual([])
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('persists every label for an account via a single queryRaw call bound with UNNEST arrays', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        id: 'al1',
        accountId: 'u1',
        labelDefinitionId: 'ld1',
        value: true,
        confidence: 1,
        reason: 'because a',
        method: 'rule-a',
        ruleVersion: '1.0.0',
        labeledAt: new Date('2026-08-04T00:00:00Z'),
        historyInserted: true,
        latestUpserted: true,
      },
      {
        id: 'al2',
        accountId: 'u1',
        labelDefinitionId: 'ld2',
        value: false,
        confidence: 0.5,
        reason: 'because b',
        method: 'rule-b',
        ruleVersion: '2.0.0',
        labeledAt: new Date('2026-08-04T00:00:00Z'),
        historyInserted: true,
        latestUpserted: true,
      },
    ])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await recordAccountLabelsBulk(prisma, {
      sourceKind: 'relabel',
      accountId: 'u1',
      labels: [
        {
          labelDefinitionId: 'ld1',
          result: { value: true, confidence: 1, reason: 'because a' },
          method: 'rule-a',
          ruleVersion: '1.0.0',
        },
        {
          labelDefinitionId: 'ld2',
          result: { value: false, confidence: 0.5, reason: 'because b' },
          method: 'rule-b',
          ruleVersion: '2.0.0',
        },
      ],
    })

    expect(result).toEqual([
      expect.objectContaining({ id: 'al1' }),
      expect.objectContaining({ id: 'al2' }),
    ])
    expect(queryRaw).toHaveBeenCalledTimes(1)
    const [sql, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(sql.join('')).toContain('UNNEST(')
    expect(sql.join('')).toContain('INSERT INTO "AccountLabel"')
    expect(sql.join('')).toContain('INSERT INTO "AccountLabelLatest"')
    // UNNEST に渡す配列は列ごとにまとめており、位置がずれると全ラベルの
    // 値が一斉に入れ替わる。列の並びどおりに配列で比較し、取り違えを検知する。
    expect(values).toEqual([
      ['mock-id', 'mock-id'],
      ['u1', 'u1'],
      ['ld1', 'ld2'],
      [true, false],
      [1, 0.5],
      ['because a', 'because b'],
      ['rule-a', 'rule-b'],
      ['1.0.0', '2.0.0'],
      // 発生源の 3 列は AccountLabel・AccountLabelLatest の両方へ同じ値を渡す。
      'relabel',
      null,
      null,
      'relabel',
      null,
      null,
    ])
  })

  it('logs a warning for each row where the AccountLabelLatest upsert guard skipped the write', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        id: 'al1',
        accountId: 'u1',
        labelDefinitionId: 'ld1',
        value: true,
        confidence: 1,
        reason: 'because a',
        method: 'rule-a',
        ruleVersion: '1.0.0',
        labeledAt: new Date('2026-08-04T00:00:00Z'),
        historyInserted: true,
        latestUpserted: false,
      },
      {
        id: 'al2',
        accountId: 'u1',
        labelDefinitionId: 'ld2',
        value: false,
        confidence: 0.5,
        reason: 'because b',
        method: 'rule-b',
        ruleVersion: '2.0.0',
        labeledAt: new Date('2026-08-04T00:00:00Z'),
        historyInserted: true,
        latestUpserted: true,
      },
    ])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient
    const { Logger } = await import('@book000/node-utils')
    const warn = vi
      .spyOn(Logger.configure('label-repository'), 'warn')
      .mockImplementation(() => undefined)

    const result = await recordAccountLabelsBulk(prisma, {
      sourceKind: 'relabel',
      accountId: 'u1',
      labels: [
        {
          labelDefinitionId: 'ld1',
          result: { value: true, confidence: 1, reason: 'because a' },
          method: 'rule-a',
          ruleVersion: '1.0.0',
        },
        {
          labelDefinitionId: 'ld2',
          result: { value: false, confidence: 0.5, reason: 'because b' },
          method: 'rule-b',
          ruleVersion: '2.0.0',
        },
      ],
    })

    expect(result).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('omits a label from the returned history when its value, ruleVersion, confidence, and reason are all unchanged from the previous latest', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        id: 'mock-id',
        accountId: 'u1',
        labelDefinitionId: 'ld1',
        value: true,
        confidence: 1,
        reason: 'because a',
        method: 'rule-a',
        ruleVersion: '1.0.0',
        labeledAt: null,
        historyInserted: false,
        latestUpserted: true,
      },
      {
        id: 'mock-id',
        accountId: 'u1',
        labelDefinitionId: 'ld2',
        value: false,
        confidence: 0.5,
        reason: 'because b',
        method: 'rule-b',
        ruleVersion: '2.0.0',
        labeledAt: new Date('2026-08-04T00:00:00Z'),
        historyInserted: true,
        latestUpserted: true,
      },
    ])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await recordAccountLabelsBulk(prisma, {
      sourceKind: 'relabel',
      accountId: 'u1',
      labels: [
        {
          labelDefinitionId: 'ld1',
          result: { value: true, confidence: 1, reason: 'because a' },
          method: 'rule-a',
          ruleVersion: '1.0.0',
        },
        {
          labelDefinitionId: 'ld2',
          result: { value: false, confidence: 0.5, reason: 'because b' },
          method: 'rule-b',
          ruleVersion: '2.0.0',
        },
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0].labelDefinitionId).toBe('ld2')
    const [sql] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    const sqlText = sql.join('')
    expect(sqlText).toContain('LEFT JOIN "AccountLabelLatest"')
    expect(sqlText).toContain('al."confidence" IS DISTINCT FROM')
    expect(sqlText).toContain('al."reason" IS DISTINCT FROM')
  })
})

describe('recordCrawlAccountLabel', () => {
  it('does not append a duplicate history row when the same crawl label was already claimed', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await expect(
      recordCrawlAccountLabel(prisma, {
        crawlRunId: 'run1',
        username: 'viewer',
        accountId: 'u1',
        labelDefinitionId: 'ld1',
        result: { value: true, confidence: 1, reason: 'because' },
        method: 'blue_verified',
        ruleVersion: '1.0.0',
      }),
    ).resolves.toBeUndefined()

    const [sql] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    const sqlText = sql.join('')
    expect(sqlText).toContain('INSERT INTO "CrawlAccountLabelRun"')
    expect(sqlText).toContain(
      'ON CONFLICT ("crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion") DO NOTHING',
    )
    expect(sqlText).toContain('WHERE EXISTS (SELECT 1 FROM claimed)')
  })

  it('includes a guard against re-inserting history when the previous latest value, ruleVersion, confidence, and reason are all unchanged', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ historyInserted: false, latestUpserted: true }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await recordCrawlAccountLabel(prisma, {
      crawlRunId: 'run1',
      username: 'viewer',
      accountId: 'u1',
      labelDefinitionId: 'ld1',
      result: { value: true, confidence: 1, reason: 'because' },
      method: 'blue_verified',
      ruleVersion: '1.0.0',
    })

    const [sql] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    const sqlText = sql.join('')
    expect(sqlText).toContain('FROM "AccountLabelLatest"')
    expect(sqlText).toContain('NOT EXISTS')
    expect(sqlText).toContain('"confidence" = ')
    expect(sqlText).toContain('"reason" = ')
  })

  it('records the crawl run and login account as the source of the label', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ latestUpserted: true }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await recordCrawlAccountLabel(prisma, {
      crawlRunId: 'run1',
      username: 'viewer',
      accountId: 'u1',
      labelDefinitionId: 'ld1',
      result: { value: true, confidence: 1, reason: 'because' },
      method: 'blue_verified',
      ruleVersion: '1.0.0',
    })

    const [sql, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    const sqlText = sql.join('')
    expect(sqlText).toContain('"sourceKind", "sourceId", "sourceUsername"')
    expect(values).toContain('run1')
    expect(values).toContain('viewer')
  })
})

describe('recordCrawlAccountLabelsAtomicWithinTx', () => {
  it('claims labels and returns an observation id without opening its own transaction', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ labelDefinitionId: 'ld1', method: 'rule', ruleVersion: 'v1' }])
    const create = vi.fn().mockResolvedValue({ id: 'observation1' })
    const upsert = vi.fn().mockResolvedValue({})
    const txClient = {
      $queryRaw: queryRaw,
      accountClassificationObservation: { create },
      accountLabel: { upsert },
      accountLabelLatest: { upsert },
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
