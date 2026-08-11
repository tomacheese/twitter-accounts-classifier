import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from './client'
import {
  enqueueWorkItem,
  requestAccountRelabel,
  requestAccountRelabelBulk,
  claimNextWorkItem,
  completeAccountRelabelWorkItem,
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
    expect(await prisma.analysisWorkItem.count()).toBe(1)
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
