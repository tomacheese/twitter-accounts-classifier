import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { LabelRule } from '../labels/types'
import {
  ensureLabelDefinition,
  ensureLabelDefinitionsForRules,
  recordAccountLabel,
  recordCrawlAccountLabel,
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

describe('recordAccountLabel', () => {
  it('inserts a new history row with the rule result fields, bound in the same order as the SQL text, via a single queryRaw call', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'al1', latestUpserted: true }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await recordAccountLabel(prisma, {
      accountId: 'u1',
      labelDefinitionId: 'ld1',
      result: { value: true, confidence: 1, reason: 'because' },
      method: 'blue_verified',
      ruleVersion: '1.0.0',
    })

    expect(result).toEqual({ id: 'al1' })
    expect(queryRaw).toHaveBeenCalledTimes(1)
    const [sql, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(sql.join('')).toContain('INSERT INTO "AccountLabel"')
    expect(sql.join('')).toContain('INSERT INTO "AccountLabelLatest"')
    // 生 SQL のバインドは位置指定のため、arrayContaining では value/confidence や
    // method/ruleVersion の入れ替わりを検知できない。SELECT に現れる順序どおりの
    // 配列と比較し、取り違えがあれば検知できるようにする。
    expect(values).toEqual([
      'mock-id',
      'u1',
      'ld1',
      true,
      1,
      'because',
      'blue_verified',
      '1.0.0',
      'u1',
      'ld1',
      true,
    ])
  })

  it('derives labeledAt from a single SQL-side now() shared by the history insert and the latest-value upsert, guarded against out-of-order writes', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'al1', latestUpserted: true }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await recordAccountLabel(prisma, {
      accountId: 'u1',
      labelDefinitionId: 'ld1',
      result: { value: true, confidence: 1, reason: 'because' },
      method: 'blue_verified',
      ruleVersion: '1.0.0',
    })

    const [sql] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    const sqlText = sql.join('')
    // labeledAt は JS の Date ではなく、両方の INSERT が共通の CTE (shared_now)
    // 経由で同じ SQL 側の now() を1回だけ評価した値を読む。now() 呼び出し自体が
    // 1箇所だけであることを確認し、アプリサーバー間のクロックスキューの影響を
    // 受けないことを保証する。
    expect(sqlText.match(/now\(\)/g)).toHaveLength(1)
    expect(sqlText).toContain('WHERE "AccountLabelLatest"."labeledAt" <= EXCLUDED."labeledAt"')
  })

  it('logs a warning when the AccountLabelLatest upsert guard skips the write', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'al1', latestUpserted: false }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient
    const { Logger } = await import('@book000/node-utils')
    const warn = vi
      .spyOn(Logger.configure('label-repository'), 'warn')
      .mockImplementation(() => undefined)

    const result = await recordAccountLabel(prisma, {
      accountId: 'u1',
      labelDefinitionId: 'ld1',
      result: { value: true, confidence: 1, reason: 'because' },
      method: 'blue_verified',
      ruleVersion: '1.0.0',
    })

    expect(result).toEqual({ id: 'al1' })
    expect(warn).toHaveBeenCalledTimes(1)
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
})
