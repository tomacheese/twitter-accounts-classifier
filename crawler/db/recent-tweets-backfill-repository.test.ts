import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { selectRecentTweetsBackfillCandidates } from './recent-tweets-backfill-repository'

function prismaReturning(accountIds: string[]): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue(accountIds.map((accountId) => ({ accountId }))),
  } as unknown as PrismaClient
}

describe('selectRecentTweetsBackfillCandidates', () => {
  it('returns a bounded page and a cursor only when a sentinel row exists', async () => {
    const prisma = prismaReturning(['account-a', 'account-b', 'account-c'])

    await expect(selectRecentTweetsBackfillCandidates(prisma, { limit: 2 })).resolves.toEqual({
      accountIds: ['account-a', 'account-b'],
      nextAfterId: 'account-b',
    })
  })

  it('omits the cursor when no next page exists', async () => {
    const prisma = prismaReturning(['account-a', 'account-b'])

    await expect(selectRecentTweetsBackfillCandidates(prisma, { limit: 2 })).resolves.toEqual({
      accountIds: ['account-a', 'account-b'],
    })
  })

  it('builds a strict keyset query for unattempted accounts with unevaluable target labels', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ accountId: 'account-b' }])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await selectRecentTweetsBackfillCandidates(prisma, { afterId: 'account-a', limit: 2 })

    const query = queryRaw.mock.calls[0]?.[0] as { sql: string; values: unknown[] }
    expect(query.sql).toContain('SELECT DISTINCT')
    expect(query.sql).toContain('a."lastRecentTweetsAttemptedAt" IS NULL')
    expect(query.sql).toContain('latest."evaluable" = false')
    expect(query.sql).toContain('definition."key" IN')
    expect(query.sql).toContain('a."id" >')
    expect(query.sql).toContain('ORDER BY a."id" ASC')
    expect(query.values).toEqual([
      'bot',
      'reply_farming',
      'reply_hijack_swarm',
      'tweet_ai_generated_media',
      'account-a',
      3,
    ])
  })

  it('does not emit duplicate account ids when several target labels match', async () => {
    const prisma = prismaReturning(['account-a', 'account-a', 'account-b'])

    await expect(selectRecentTweetsBackfillCandidates(prisma, { limit: 2 })).resolves.toEqual({
      accountIds: ['account-a', 'account-b'],
    })
  })
})
