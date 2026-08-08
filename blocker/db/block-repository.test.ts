import { describe, expect, it, vi } from 'vitest'
import { recordSuccessfulBlock } from './block-repository'

describe('recordSuccessfulBlock', () => {
  it('upserts the Block row with firstSeenAt/lastSeenAt set to now', async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = { block: { upsert } }

    await recordSuccessfulBlock(prisma as never, 'blocker-1', 'blocked-1', 'run-1')

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blockerId_blockedId: { blockerId: 'blocker-1', blockedId: 'blocked-1' } },
      }),
    )
    const call = upsert.mock.calls[0][0] as {
      create: { blockerId: string; blockedId: string; sourceKind: string; sourceId: string }
      update: { lastSeenAt: Date }
    }
    expect(call.create.blockerId).toBe('blocker-1')
    expect(call.create.blockedId).toBe('blocked-1')
    expect(call.update.lastSeenAt).toBeInstanceOf(Date)
  })

  it('records the BlockAccountRun as the source of a newly created Block row', async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = { block: { upsert } }

    await recordSuccessfulBlock(prisma as never, 'blocker-1', 'blocked-1', 'run-1')

    const call = upsert.mock.calls[0][0] as {
      create: { sourceKind: string; sourceId: string }
      update: Record<string, unknown>
    }
    expect(call.create.sourceKind).toBe('blocker')
    expect(call.create.sourceId).toBe('run-1')
    // 既存行 (crawler が観測済みの正本) の発生源を blocker 側で上書きしない。
    expect(call.update.sourceKind).toBeUndefined()
    expect(call.update.sourceId).toBeUndefined()
  })
})
