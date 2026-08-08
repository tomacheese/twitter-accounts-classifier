import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import { computeFreshnessStatus, refreshReadModelFreshness } from './freshness'

describe('computeFreshnessStatus', () => {
  const cadenceMs = 6 * 60 * 60 * 1000

  it('予定範囲内なら current を返す', () => {
    const now = new Date('2026-08-07T12:00:00Z')
    const lastSuccessAt = new Date('2026-08-07T07:00:00Z')
    expect(
      computeFreshnessStatus({
        lastSuccessAt,
        cadenceMs,
        delayedAfterMs: cadenceMs * 1.5,
        staleAfterMs: cadenceMs * 3,
        now,
      }),
    ).toBe('current')
  })

  it('delayedAfter を超えたら delayed を返す', () => {
    const now = new Date('2026-08-07T16:00:00Z')
    const lastSuccessAt = new Date('2026-08-07T07:00:00Z')
    expect(
      computeFreshnessStatus({
        lastSuccessAt,
        cadenceMs,
        delayedAfterMs: cadenceMs * 1.5,
        staleAfterMs: cadenceMs * 3,
        now,
      }),
    ).toBe('delayed')
  })

  it('staleAfter を超えたら stale を返す', () => {
    const now = new Date('2026-08-08T08:00:00Z')
    const lastSuccessAt = new Date('2026-08-07T07:00:00Z')
    expect(
      computeFreshnessStatus({
        lastSuccessAt,
        cadenceMs,
        delayedAfterMs: cadenceMs * 1.5,
        staleAfterMs: cadenceMs * 3,
        now,
      }),
    ).toBe('stale')
  })

  it('lastSuccessAt が無ければ unknown を返す', () => {
    const now = new Date('2026-08-07T12:00:00Z')
    expect(
      computeFreshnessStatus({
        lastSuccessAt: undefined,
        cadenceMs,
        delayedAfterMs: cadenceMs * 1.5,
        staleAfterMs: cadenceMs * 3,
        now,
      }),
    ).toBe('unknown')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('refreshReadModelFreshness', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.readModelState.deleteMany()
  })

  const thresholds = {
    cadenceMs: 60 * 60 * 1000,
    delayedAfterMs: 3 * 60 * 60 * 1000,
    staleAfterMs: 12 * 60 * 60 * 1000,
  }

  it('最終成功から時間が経った healthy な read model を stale に落とす', async () => {
    const now = new Date('2026-01-02T00:00:00Z')
    await prisma.readModelState.create({
      data: {
        modelKey: 'label_summary',
        schemaVersion: 1,
        status: 'healthy',
        lastSuccessAt: new Date('2026-01-01T00:00:00Z'),
      },
    })

    const updated = await refreshReadModelFreshness(prisma, { ...thresholds, now })

    expect(updated).toEqual(['label_summary'])
    const state = await prisma.readModelState.findUniqueOrThrow({
      where: { modelKey: 'label_summary' },
    })
    expect(state.status).toBe('stale')
    expect(state.staleAt).not.toBeNull()
    expect(state.expectedNextAt).toEqual(new Date('2026-01-01T01:00:00Z'))
  })

  it('直近に成功していれば healthy のまま更新しない', async () => {
    const now = new Date('2026-01-01T00:30:00Z')
    await prisma.readModelState.create({
      data: {
        modelKey: 'label_summary',
        schemaVersion: 1,
        status: 'healthy',
        lastSuccessAt: new Date('2026-01-01T00:00:00Z'),
      },
    })

    const updated = await refreshReadModelFreshness(prisma, { ...thresholds, now })

    expect(updated).toEqual([])
  })

  it('一度も成功していない read model は unknown にする', async () => {
    await prisma.readModelState.create({
      data: { modelKey: 'attention_items', schemaVersion: 1, status: 'healthy' },
    })

    await refreshReadModelFreshness(prisma, { ...thresholds, now: new Date() })

    const state = await prisma.readModelState.findUniqueOrThrow({
      where: { modelKey: 'attention_items' },
    })
    expect(state.status).toBe('unknown')
  })

  it('publish が記録した failed を時間経過で上書きしない', async () => {
    await prisma.readModelState.create({
      data: {
        modelKey: 'overview_snapshot',
        schemaVersion: 1,
        status: 'failed',
        lastSuccessAt: new Date('2026-01-01T00:00:00Z'),
      },
    })

    await refreshReadModelFreshness(prisma, {
      ...thresholds,
      now: new Date('2026-02-01T00:00:00Z'),
    })

    const state = await prisma.readModelState.findUniqueOrThrow({
      where: { modelKey: 'overview_snapshot' },
    })
    expect(state.status).toBe('failed')
  })
})
