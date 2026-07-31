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
  it('creates a new history row with the rule result fields', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'al1' })
    const prisma = { accountLabel: { create } } as unknown as PrismaClient

    await recordAccountLabel(prisma, {
      accountId: 'u1',
      labelDefinitionId: 'ld1',
      result: { value: true, confidence: 1, reason: 'because' },
      method: 'blue_verified',
      ruleVersion: '1.0.0',
    })

    const call = create.mock.calls[0][0] as Record<string, unknown>
    expect(call.data).toMatchObject({
      accountId: 'u1',
      labelDefinitionId: 'ld1',
      value: true,
      confidence: 1,
      reason: 'because',
      method: 'blue_verified',
      ruleVersion: '1.0.0',
    })
  })
})
