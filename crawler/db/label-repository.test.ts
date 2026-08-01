import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { LabelRule } from '../labels/types'
import {
  ensureLabelDefinition,
  ensureLabelDefinitionsForRules,
  recordAccountLabel,
} from './label-repository'

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
  it('inserts a new history row with the rule result fields via a single queryRaw call', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'al1' }])
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
    expect(values).toEqual(
      expect.arrayContaining(['u1', 'ld1', true, 1, 'because', 'blue_verified', '1.0.0']),
    )
  })

  it('shares one labeledAt between the history insert and the latest-value upsert, guarded against out-of-order writes', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'al1' }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await recordAccountLabel(prisma, {
      accountId: 'u1',
      labelDefinitionId: 'ld1',
      result: { value: true, confidence: 1, reason: 'because' },
      method: 'blue_verified',
      ruleVersion: '1.0.0',
    })

    const [sql, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(sql.join('')).toContain('WHERE "AccountLabelLatest"."labeledAt" <= EXCLUDED."labeledAt"')
    const labeledAtValues = values.filter((value) => value instanceof Date)
    // history 側と upsert 側、両方の labeledAt にちょうど1つの Date インスタンスが渡り、
    // 同じ値を共有していることを確認する。
    expect(labeledAtValues).toHaveLength(2)
    expect(labeledAtValues[0]).toEqual(labeledAtValues[1])
  })
})
