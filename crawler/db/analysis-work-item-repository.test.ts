import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { getPrismaClient } from './client'
import {
  enqueueWorkItem,
  requestAccountRelabel,
  requestAccountRelabelBulk,
  claimNextWorkItem,
  claimWorkItemBatchByIds,
  completeAccountRelabelWorkItem,
  peekWorkItemCandidates,
} from './analysis-work-item-repository'

describe.skipIf(!process.env.DATABASE_URL)('enqueueWorkItem (crawler)', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
  })

  it('同じ kind + triggerType + triggerId を重複投入しない', async () => {
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-x',
    })
    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-x',
    })
    await enqueueWorkItem(prisma, {
      kind: 'account_relabel',
      triggerType: 'account',
      triggerId: 'another-account',
    })
    expect(
      await prisma.analysisWorkItem.count({
        where: {
          kind: 'label_metrics',
          triggerType: 'crawl_run',
          triggerId: 'crawl-x',
        },
      }),
    ).toBe(1)
  })
})

describe.skipIf(!process.env.DATABASE_URL)(
  'requestAccountRelabel / completeAccountRelabelWorkItem',
  () => {
    const prisma = getPrismaClient()

    beforeEach(async () => {
      await prisma.analysisWorkItem.deleteMany()
    })

    it('新規 account を queued として作成する', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const item = await prisma.analysisWorkItem.findUniqueOrThrow({
        where: {
          kind_triggerType_triggerId: {
            kind: 'account_relabel',
            triggerType: 'account',
            triggerId: 'acct-1',
          },
        },
      })
      expect(item.status).toBe('queued')
    })

    it('succeeded だった account を queued に戻す', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const claimed = await claimNextWorkItem(prisma, {
        kinds: ['account_relabel'],
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })
      if (!claimed) throw new Error('claim に失敗した')
      await completeAccountRelabelWorkItem(prisma, {
        workItemId: claimed.id,
        leaseOwner: 'worker-1',
      })

      await requestAccountRelabel(prisma, 'acct-1')

      const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: claimed.id } })
      expect(item.status).toBe('queued')
    })

    it('bulk でも succeeded だった account を queued に戻す', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const existing = await prisma.analysisWorkItem.findFirstOrThrow({
        where: { kind: 'account_relabel', triggerType: 'account', triggerId: 'acct-1' },
      })
      await prisma.analysisWorkItem.update({
        where: { id: existing.id },
        data: { status: 'succeeded' },
      })

      await requestAccountRelabelBulk(prisma, ['acct-1'])

      const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
      expect(item.status).toBe('queued')
    })

    it('レース: leased 中に再要求が来た場合、complete で succeeded にならず queued に戻る', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const claimed = await claimNextWorkItem(prisma, {
        kinds: ['account_relabel'],
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })
      if (!claimed) throw new Error('claim に失敗した')

      // worker がスナップショットを評価している間に、別経路から新しい変更要求が来る。
      await requestAccountRelabel(prisma, 'acct-1')

      const outcome = await completeAccountRelabelWorkItem(prisma, {
        workItemId: claimed.id,
        leaseOwner: 'worker-1',
      })
      expect(outcome).toBe('requeued')

      const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: claimed.id } })
      expect(item.status).toBe('queued')
      expect(item.staleRequestedAt).toBeNull()

      // 追加の要求なしで再度 claim → complete すれば、今度こそ succeeded になる。
      const reclaimed = await claimNextWorkItem(prisma, {
        kinds: ['account_relabel'],
        leaseOwner: 'worker-2',
        leaseDurationMs: 60_000,
      })
      if (!reclaimed) throw new Error('再 claim に失敗した')
      const secondOutcome = await completeAccountRelabelWorkItem(prisma, {
        workItemId: reclaimed.id,
        leaseOwner: 'worker-2',
      })
      expect(secondOutcome).toBe('succeeded')
    })
  },
)

describe('peekWorkItemCandidates (mock)', () => {
  it('limit <= 0 の場合は DB へ問い合わせず空配列を返す', async () => {
    const queryRaw = vi.fn()
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await peekWorkItemCandidates(prisma, { kinds: ['account_relabel'], limit: 0 })

    expect(result).toEqual([])
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('$queryRaw が返した id・triggerId をそのまま返す (lease は更新しない)', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await peekWorkItemCandidates(prisma, {
      kinds: ['account_relabel'],
      limit: 10,
    })

    expect(result).toEqual([
      { id: 'wi-1', triggerId: 'alice' },
      { id: 'wi-2', triggerId: 'bob' },
    ])
    expect(queryRaw).toHaveBeenCalledTimes(1)
    const sql = (queryRaw.mock.calls[0][0] as unknown[]).join('')
    expect(sql).not.toContain('FOR UPDATE')
    expect(sql).not.toContain('UPDATE "AnalysisWorkItem"')
  })
})

describe('claimWorkItemBatchByIds (mock)', () => {
  it('ids が空の場合は DB へ問い合わせず空配列を返す', async () => {
    const queryRaw = vi.fn()
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await claimWorkItemBatchByIds(prisma, {
      ids: [],
      leaseOwner: 'worker-1',
      leaseDurationMs: 60_000,
    })

    expect(result).toEqual([])
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('id = ANY(...) を条件に FOR UPDATE SKIP LOCKED で claim する', async () => {
    const claimedRow = { id: 'wi-1', triggerId: 'alice', status: 'leased' }
    const queryRaw = vi.fn().mockResolvedValue([claimedRow])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await claimWorkItemBatchByIds(prisma, {
      ids: ['wi-1', 'wi-2'],
      leaseOwner: 'worker-1',
      leaseDurationMs: 60_000,
    })

    expect(result).toEqual([claimedRow])
    const sql = (queryRaw.mock.calls[0][0] as unknown[]).join('')
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain('"id" = ANY(')
    expect(sql).not.toContain('ORDER BY')
  })
})

describe.skipIf(!process.env.DATABASE_URL)(
  'peekWorkItemCandidates / claimWorkItemBatchByIds (DB)',
  () => {
    const prisma = getPrismaClient()

    beforeEach(async () => {
      await prisma.analysisWorkItem.deleteMany()
    })

    it('peek は lease を更新しない', async () => {
      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2'])

      const candidates = await peekWorkItemCandidates(prisma, {
        kinds: ['account_relabel'],
        limit: 10,
      })

      expect(candidates.map((c) => c.triggerId).toSorted()).toEqual(['acct-1', 'acct-2'])
      const items = await prisma.analysisWorkItem.findMany()
      expect(items.every((item) => item.status === 'queued')).toBe(true)
      expect(items.every((item) => item.leaseOwner === null)).toBe(true)
    })

    it('peek した id 集合だけを claim でき、集合外の id は claim されない', async () => {
      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2', 'acct-3'])
      const all = await prisma.analysisWorkItem.findMany({ orderBy: { triggerId: 'asc' } })
      const candidateIds = all.filter((item) => item.triggerId !== 'acct-3').map((item) => item.id)

      const claimed = await claimWorkItemBatchByIds(prisma, {
        ids: candidateIds,
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })

      expect(claimed.map((item) => item.triggerId).toSorted()).toEqual(['acct-1', 'acct-2'])
      const acct3 = await prisma.analysisWorkItem.findFirstOrThrow({
        where: { triggerId: 'acct-3' },
      })
      expect(acct3.status).toBe('queued')
      expect(acct3.leaseOwner).toBeNull()
    })

    it('競合: 既に claim 済みの id は SKIP LOCKED により対象から除外される', async () => {
      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2'])
      const all = await prisma.analysisWorkItem.findMany({ orderBy: { triggerId: 'asc' } })
      const ids = all.map((item) => item.id)

      const firstClaim = await claimWorkItemBatchByIds(prisma, {
        ids,
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })
      expect(firstClaim).toHaveLength(2)

      const secondClaim = await claimWorkItemBatchByIds(prisma, {
        ids,
        leaseOwner: 'worker-2',
        leaseDurationMs: 60_000,
      })
      expect(secondClaim).toHaveLength(0)
    })

    it('期限切れ lease を再 claim して attemptCount を増やす', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const first = await claimNextWorkItem(prisma, {
        kinds: ['account_relabel'],
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })
      if (!first) throw new Error('初回 claim に失敗した')
      await prisma.analysisWorkItem.update({
        where: { id: first.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      })

      const reclaimed = await claimWorkItemBatchByIds(prisma, {
        ids: [first.id],
        leaseOwner: 'worker-2',
        leaseDurationMs: 60_000,
      })

      expect(reclaimed).toHaveLength(1)
      expect(reclaimed[0].leaseOwner).toBe('worker-2')
      expect(reclaimed[0].attemptCount).toBe(2)
    })
  },
)
