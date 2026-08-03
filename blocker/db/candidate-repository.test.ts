import { describe, expect, it, vi } from 'vitest'
import { selectBlockCandidates } from './candidate-repository'

function fakePrismaReturning(rows: unknown[]) {
  return {
    $queryRaw: vi.fn().mockImplementation((strings: readonly string[]) => {
      const sql = strings.join('')
      expect(sql).toContain('DISTINCT ON')
      return Promise.resolve(rows)
    }),
  }
}

describe('selectBlockCandidates', () => {
  it('returns rows ordered by confidence desc, capped at maxCount', async () => {
    const prisma = fakePrismaReturning([
      { accountId: 'spam-1', labelDefinitionId: 'label-spam', confidence: 0.99 },
      { accountId: 'spam-2', labelDefinitionId: 'label-spam', confidence: 0.85 },
    ])

    const result = await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: ['spam', 'bot'], confidenceThreshold: 0.8 },
      50,
    )

    expect(result).toEqual([
      { accountId: 'spam-1', labelDefinitionId: 'label-spam', confidence: 0.99 },
      { accountId: 'spam-2', labelDefinitionId: 'label-spam', confidence: 0.85 },
    ])
  })

  it('passes confidenceThreshold, targetLabels, blockerId and the cap as query parameters', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: ['spam'], confidenceThreshold: 0.9 },
      10,
    )

    const [, ...values] = prisma.$queryRaw.mock.calls[0]
    expect(values).toContain('blocker-1')
    expect(values).toEqual(expect.arrayContaining([['spam'], 0.9, 10]))
  })

  it('returns an empty array when no row satisfies the rule', async () => {
    const prisma = fakePrismaReturning([])

    const result = await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: ['spam'], confidenceThreshold: 0.9 },
      50,
    )

    expect(result).toEqual([])
  })
})

describe('selectBlockCandidates SQL shape', () => {
  it('excludes rows via NOT EXISTS against Block, BlockAction, and Follow', async () => {
    const prisma = fakePrismaReturning([])

    await selectBlockCandidates(
      prisma as never,
      'blocker-1',
      { targetLabels: ['spam'], confidenceThreshold: 0.8 },
      50,
    )

    const [strings] = prisma.$queryRaw.mock.calls[0]
    const sql = (strings as readonly string[]).join('')
    expect(sql).toContain('"Block"')
    expect(sql).toContain('"BlockAction"')
    expect(sql).toContain('"Follow"')
    expect(sql).toContain(`ba."result" = 'success'`)
  })
})
