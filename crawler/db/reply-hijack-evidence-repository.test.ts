import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { upsertReplyHijackEvidence } from './reply-hijack-evidence-repository'

describe('upsertReplyHijackEvidence', () => {
  it('upserts evidence idempotently by account, target, and rule version', async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = { replyHijackEvidence: { upsert } } as unknown as PrismaClient
    const evidence = {
      accountId: 'account-1',
      targetTweetId: 'target-1',
      ruleVersion: 'synthetic-rule/1',
      swarmSize: 5,
      averageSimilarity: 0.75,
      spanHours: 4,
      replyTweetIds: ['reply-1', 'reply-2', 'reply-3', 'reply-4', 'reply-5'],
    }

    await upsertReplyHijackEvidence(prisma, evidence)

    expect(upsert).toHaveBeenCalledWith({
      where: {
        accountId_targetTweetId_ruleVersion: {
          accountId: 'account-1',
          targetTweetId: 'target-1',
          ruleVersion: 'synthetic-rule/1',
        },
      },
      create: evidence,
      update: {
        observedAt: expect.any(Date),
        swarmSize: 5,
        averageSimilarity: 0.75,
        spanHours: 4,
        replyTweetIds: ['reply-1', 'reply-2', 'reply-3', 'reply-4', 'reply-5'],
      },
    })
  })
})
