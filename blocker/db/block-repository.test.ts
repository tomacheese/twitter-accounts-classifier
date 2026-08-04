import { describe, expect, it, vi } from 'vitest'
import { recordSuccessfulBlock } from './block-repository'

describe('recordSuccessfulBlock', () => {
  it('upserts the Block row with firstSeenAt/lastSeenAt set to now', async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = { block: { upsert } }

    await recordSuccessfulBlock(prisma as never, 'blocker-1', 'blocked-1')

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blockerId_blockedId: { blockerId: 'blocker-1', blockedId: 'blocked-1' } },
      }),
    )
    const call = upsert.mock.calls[0][0] as {
      create: { blockerId: string; blockedId: string }
      update: { lastSeenAt: Date }
    }
    expect(call.create.blockerId).toBe('blocker-1')
    expect(call.create.blockedId).toBe('blocked-1')
    expect(call.update.lastSeenAt).toBeInstanceOf(Date)
  })
})
