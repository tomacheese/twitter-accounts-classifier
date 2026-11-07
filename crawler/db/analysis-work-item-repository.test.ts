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
  completeAccountRelabelWorkItemsBulk,
  peekWorkItemCandidates,
  recoverExhaustedExpiredWorkItems,
} from './analysis-work-item-repository'

describe.skipIf(!process.env.DATABASE_URL)('enqueueWorkItem (crawler)', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
    await prisma.analysisWorkItemDone.deleteMany()
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
  it('台帳に完了済みの論理キーがあれば、キューに入れない', async () => {
    await prisma.analysisWorkItemDone.create({
      data: {
        kind: 'label_metrics',
        triggerType: 'crawl_run',
        triggerId: 'crawl-done',
        workItemId: 1,
        attemptCount: 1,
        createdAt: new Date(),
      },
    })

    await enqueueWorkItem(prisma, {
      kind: 'label_metrics',
      triggerType: 'crawl_run',
      triggerId: 'crawl-done',
    })

    expect(await prisma.analysisWorkItem.count()).toBe(0)
  })

  it('同じ論理キーを並行して投入しても 1 行にまとまる', async () => {
    const key = { kind: 'label_metrics', triggerType: 'crawl_run', triggerId: 'crawl-race' }
    await Promise.all(Array.from({ length: 20 }, () => enqueueWorkItem(prisma, key)))
    await enqueueWorkItem(prisma, { ...key, triggerId: 'crawl-next' })

    const rows = await prisma.analysisWorkItem.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((row) => row.triggerId)).toEqual(['crawl-race', 'crawl-next'])
  })

  it('トランザクション内の enqueue はロールバックされる', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueWorkItem(tx, {
          kind: 'label_metrics',
          triggerType: 'crawl_run',
          triggerId: 'crawl-rollback',
        })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    expect(await prisma.analysisWorkItem.count()).toBe(0)
  })
})

describe.skipIf(!process.env.DATABASE_URL)(
  'requestAccountRelabel / completeAccountRelabelWorkItem',
  () => {
    const prisma = getPrismaClient()

    beforeEach(async () => {
      await prisma.analysisWorkItem.deleteMany()
      await prisma.analysisWorkItemDone.deleteMany()
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

    it('完了済みの account はキュー表から消え、台帳には入らず、再要求で新しい行として積み直される', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const claimed = await claimNextWorkItem(prisma, {
        kinds: ['account_relabel'],
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })
      if (!claimed) throw new Error('claim に失敗した')
      expect(
        await completeAccountRelabelWorkItem(prisma, {
          workItemId: claimed.id,
          leaseOwner: 'worker-1',
        }),
      ).toBe('succeeded')
      expect(await prisma.analysisWorkItem.count()).toBe(0)
      expect(await prisma.analysisWorkItemDone.count()).toBe(0)

      await requestAccountRelabel(prisma, 'acct-1')

      const item = await prisma.analysisWorkItem.findFirstOrThrow()
      expect(item.status).toBe('queued')
      expect(item.id).not.toBe(claimed.id)
      expect(item.attemptCount).toBe(0)
    })

    it('bulk でも、完了済みの account を新しい行として積み直す', async () => {
      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2'])
      const queuedRows = await prisma.analysisWorkItem.findMany()
      const claimed = await claimWorkItemBatchByIds(prisma, {
        ids: queuedRows.map((row) => row.id),
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })
      await completeAccountRelabelWorkItemsBulk(prisma, {
        workItemIds: claimed.map((row) => row.id),
        leaseOwner: 'worker-1',
      })
      expect(await prisma.analysisWorkItem.count()).toBe(0)

      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2'])

      const rows = await prisma.analysisWorkItem.findMany({ orderBy: { triggerId: 'asc' } })
      expect(rows.map((row) => [row.triggerId, row.status])).toEqual([
        ['acct-1', 'queued'],
        ['acct-2', 'queued'],
      ])
    })

    it('failed・dead の行は bulk の再要求で queued に戻る', async () => {
      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2'])
      const [first, second] = await prisma.analysisWorkItem.findMany({ orderBy: { id: 'asc' } })
      await prisma.analysisWorkItem.update({
        where: { id: first.id },
        data: { status: 'failed', attemptCount: 3 },
      })
      await prisma.analysisWorkItem.update({ where: { id: second.id }, data: { status: 'dead' } })

      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2'])

      const rows = await prisma.analysisWorkItem.findMany({ orderBy: { id: 'asc' } })
      expect(rows.map((row) => [row.id, row.status, row.attemptCount])).toEqual([
        [first.id, 'queued', 0],
        [second.id, 'queued', 0],
      ])
    })

    it('既存行への再要求は、行数も識別子の採番も増やさない', async () => {
      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-1', 'acct-2'])
      const before = await prisma.analysisWorkItem.findMany({ orderBy: { id: 'asc' } })
      expect(before).toHaveLength(2)

      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2'])
      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-3'])

      const after = await prisma.analysisWorkItem.findMany({ orderBy: { id: 'asc' } })
      expect(after.map((row) => row.triggerId)).toEqual(['acct-1', 'acct-2', 'acct-3'])
      expect(after[2].id - after[1].id).toBe(1)
    })

    it('同じ account を並行して要求しても 1 行にまとまる', async () => {
      await Promise.all(
        Array.from({ length: 10 }, () => requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2'])),
      )

      expect(await prisma.analysisWorkItem.count()).toBe(2)
    })

    it('2 万 account の bulk 要求を 1 回の呼び出しで、数秒以内に処理する', async () => {
      const accountIds = Array.from({ length: 20_000 }, (_, i) => `bulk-${i}`)
      await requestAccountRelabelBulk(prisma, accountIds.slice(0, 10_000))

      const started = Date.now()
      await requestAccountRelabelBulk(prisma, accountIds)
      const elapsedMs = Date.now() - started

      expect(await prisma.analysisWorkItem.count()).toBe(20_000)
      expect(elapsedMs).toBeLessThan(10_000)
    }, 30_000)

    it('完了の bulk は、変更要求が来た行だけを queued に戻し、残りを削除する', async () => {
      await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2', 'acct-3'])
      const queuedRows = await prisma.analysisWorkItem.findMany()
      const claimed = await claimWorkItemBatchByIds(prisma, {
        ids: queuedRows.map((row) => row.id),
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })
      await requestAccountRelabel(prisma, 'acct-2')

      const outcomes = await completeAccountRelabelWorkItemsBulk(prisma, {
        workItemIds: claimed.map((row) => row.id),
        leaseOwner: 'worker-1',
      })

      const byId = new Map(claimed.map((row) => [row.id, row.triggerId]))
      expect(outcomes.map((row) => [byId.get(row.id), row.status]).toSorted()).toEqual([
        ['acct-1', 'succeeded'],
        ['acct-2', 'requeued'],
        ['acct-3', 'succeeded'],
      ])
      const remaining = await prisma.analysisWorkItem.findMany()
      expect(remaining.map((row) => [row.triggerId, row.status])).toEqual([['acct-2', 'queued']])
    })

    it('完了が行ロックを保持している間に届いた再要求は、完了後に新しい行として積み直される', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const claimed = await claimNextWorkItem(prisma, {
        kinds: ['account_relabel'],
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })
      if (!claimed) throw new Error('claim に失敗した')

      let request: Promise<void> | undefined
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AnalysisWorkItem" WHERE "id" = ${claimed.id} FOR UPDATE`
        request = requestAccountRelabelBulk(prisma, ['acct-1'])
        await new Promise((resolve) => setTimeout(resolve, 300))
        await completeAccountRelabelWorkItemsBulk(tx, {
          workItemIds: [claimed.id],
          leaseOwner: 'worker-1',
        })
      })
      await request

      const rows = await prisma.analysisWorkItem.findMany()
      expect(rows.map((row) => [row.triggerId, row.status])).toEqual([['acct-1', 'queued']])
    })

    it('別 owner の完了は何も変えず、lease_lost を返す', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const claimed = await claimNextWorkItem(prisma, {
        kinds: ['account_relabel'],
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })
      if (!claimed) throw new Error('claim に失敗した')

      const outcome = await completeAccountRelabelWorkItem(prisma, {
        workItemId: claimed.id,
        leaseOwner: 'worker-2',
      })

      expect(outcome).toBe('lease_lost')
      const row = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: claimed.id } })
      expect(row.status).toBe('leased')
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

    it('レース (bulk 版): leased 中に再要求が来た場合、complete で succeeded にならず queued に戻る', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const claimed = await claimNextWorkItem(prisma, {
        kinds: ['account_relabel'],
        leaseOwner: 'worker-1',
        leaseDurationMs: 60_000,
      })
      if (!claimed) throw new Error('claim に失敗した')

      // worker がスナップショットを評価している間に、別経路から新しい変更要求が来る。
      await requestAccountRelabel(prisma, 'acct-1')

      const outcomes = await completeAccountRelabelWorkItemsBulk(prisma, {
        workItemIds: [claimed.id],
        leaseOwner: 'worker-1',
      })
      expect(outcomes).toEqual([{ id: claimed.id, status: 'requeued' }])

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
      const secondOutcomes = await completeAccountRelabelWorkItemsBulk(prisma, {
        workItemIds: [reclaimed.id],
        leaseOwner: 'worker-2',
      })
      expect(secondOutcomes).toEqual([{ id: reclaimed.id, status: 'succeeded' }])
    })
  },
)

describe.skipIf(!process.env.DATABASE_URL)(
  'requestAccountRelabel / requestAccountRelabelBulk: 期限切れ + attemptCount 使い切りの回収 (DB)',
  () => {
    const prisma = getPrismaClient()

    beforeEach(async () => {
      await prisma.analysisWorkItem.deleteMany()
      await prisma.analysisWorkItemDone.deleteMany()
    })

    it('期限切れかつ attemptCount 使い切りの leased 行は request で queued に全リセットされる', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const existing = await prisma.analysisWorkItem.findFirstOrThrow({
        where: { kind: 'account_relabel', triggerType: 'account', triggerId: 'acct-1' },
      })
      await prisma.analysisWorkItem.update({
        where: { id: existing.id },
        data: {
          status: 'leased',
          leaseOwner: 'dead-worker',
          leaseExpiresAt: new Date(Date.now() - 1000),
          attemptCount: 5,
          maxAttempts: 5,
        },
      })

      await requestAccountRelabel(prisma, 'acct-1')

      const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
      expect(item.status).toBe('queued')
      expect(item.attemptCount).toBe(0)
      expect(item.leaseOwner).toBeNull()
      expect(item.leaseExpiresAt).toBeNull()
      expect(item.staleRequestedAt).toBeNull()
    })

    it('bulk でも期限切れかつ attemptCount 使い切りの leased 行は queued に全リセットされる', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const existing = await prisma.analysisWorkItem.findFirstOrThrow({
        where: { kind: 'account_relabel', triggerType: 'account', triggerId: 'acct-1' },
      })
      await prisma.analysisWorkItem.update({
        where: { id: existing.id },
        data: {
          status: 'leased',
          leaseOwner: 'dead-worker',
          leaseExpiresAt: new Date(Date.now() - 1000),
          attemptCount: 5,
          maxAttempts: 5,
        },
      })

      await requestAccountRelabelBulk(prisma, ['acct-1'])

      const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
      expect(item.status).toBe('queued')
      expect(item.attemptCount).toBe(0)
      expect(item.leaseOwner).toBeNull()
    })

    it('lease がまだ有効な leased 行は request で従来通り staleRequestedAt を立てるだけにする (回帰)', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const existing = await prisma.analysisWorkItem.findFirstOrThrow({
        where: { kind: 'account_relabel', triggerType: 'account', triggerId: 'acct-1' },
      })
      await prisma.analysisWorkItem.update({
        where: { id: existing.id },
        data: {
          status: 'leased',
          leaseOwner: 'live-worker',
          leaseExpiresAt: new Date(Date.now() + 60_000),
          attemptCount: 5,
          maxAttempts: 5,
        },
      })

      await requestAccountRelabel(prisma, 'acct-1')

      const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
      expect(item.status).toBe('leased')
      expect(item.leaseOwner).toBe('live-worker')
      expect(item.attemptCount).toBe(5)
      expect(item.staleRequestedAt).not.toBeNull()
    })

    it('leaseExpiresAt が NULL かつ attemptCount 使い切りの leased 行も claim 述語同様に失効扱いで queued に全リセットされる', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const existing = await prisma.analysisWorkItem.findFirstOrThrow({
        where: { kind: 'account_relabel', triggerType: 'account', triggerId: 'acct-1' },
      })
      await prisma.analysisWorkItem.update({
        where: { id: existing.id },
        data: {
          status: 'leased',
          leaseOwner: 'dead-worker',
          leaseExpiresAt: null,
          attemptCount: 5,
          maxAttempts: 5,
        },
      })

      await requestAccountRelabel(prisma, 'acct-1')

      const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
      expect(item.status).toBe('queued')
      expect(item.attemptCount).toBe(0)
      expect(item.staleRequestedAt).toBeNull()
    })

    it('bulk でも leaseExpiresAt が NULL かつ attemptCount 使い切りの leased 行は queued に全リセットされる', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const existing = await prisma.analysisWorkItem.findFirstOrThrow({
        where: { kind: 'account_relabel', triggerType: 'account', triggerId: 'acct-1' },
      })
      await prisma.analysisWorkItem.update({
        where: { id: existing.id },
        data: {
          status: 'leased',
          leaseOwner: 'dead-worker',
          leaseExpiresAt: null,
          attemptCount: 5,
          maxAttempts: 5,
        },
      })

      await requestAccountRelabelBulk(prisma, ['acct-1'])

      const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
      expect(item.status).toBe('queued')
      expect(item.attemptCount).toBe(0)
    })

    it('期限切れでも attemptCount が残っている leased 行は request で従来通り staleRequestedAt を立てるだけにする', async () => {
      await requestAccountRelabel(prisma, 'acct-1')
      const existing = await prisma.analysisWorkItem.findFirstOrThrow({
        where: { kind: 'account_relabel', triggerType: 'account', triggerId: 'acct-1' },
      })
      await prisma.analysisWorkItem.update({
        where: { id: existing.id },
        data: {
          status: 'leased',
          leaseOwner: 'dead-worker',
          leaseExpiresAt: new Date(Date.now() - 1000),
          attemptCount: 2,
          maxAttempts: 5,
        },
      })

      await requestAccountRelabel(prisma, 'acct-1')

      const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
      expect(item.status).toBe('leased')
      expect(item.attemptCount).toBe(2)
      expect(item.staleRequestedAt).not.toBeNull()
    })
  },
)

describe.skipIf(!process.env.DATABASE_URL)('recoverExhaustedExpiredWorkItems (DB)', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.analysisWorkItem.deleteMany()
    await prisma.analysisWorkItemDone.deleteMany()
  })

  it('staleRequestedAt が立っている orphan は queued に戻す', async () => {
    await requestAccountRelabel(prisma, 'acct-1')
    const existing = await prisma.analysisWorkItem.findFirstOrThrow({
      where: { triggerId: 'acct-1' },
    })
    await prisma.analysisWorkItem.update({
      where: { id: existing.id },
      data: {
        status: 'leased',
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 1000),
        attemptCount: 5,
        maxAttempts: 5,
        staleRequestedAt: new Date(),
      },
    })

    const result = await recoverExhaustedExpiredWorkItems(prisma, {
      kind: 'account_relabel',
      batchSize: 10,
    })

    expect(result).toEqual({ reArmed: 1, parkedAsFailed: 0 })
    const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
    expect(item.status).toBe('queued')
    expect(item.attemptCount).toBe(0)
    expect(item.leaseOwner).toBeNull()
    expect(item.staleRequestedAt).toBeNull()
  })

  it('leaseExpiresAt が NULL の orphan も claim 述語同様に失効扱いで回収する', async () => {
    await requestAccountRelabel(prisma, 'acct-1')
    const existing = await prisma.analysisWorkItem.findFirstOrThrow({
      where: { triggerId: 'acct-1' },
    })
    await prisma.analysisWorkItem.update({
      where: { id: existing.id },
      data: {
        status: 'leased',
        leaseOwner: 'dead-worker',
        leaseExpiresAt: null,
        attemptCount: 5,
        maxAttempts: 5,
      },
    })

    const result = await recoverExhaustedExpiredWorkItems(prisma, {
      kind: 'account_relabel',
      batchSize: 10,
    })

    expect(result).toEqual({ reArmed: 0, parkedAsFailed: 1 })
    const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
    expect(item.status).toBe('failed')
    expect(item.leaseOwner).toBeNull()
  })

  it('staleRequestedAt が立っていない orphan は無限 retry させず failed に park する', async () => {
    await requestAccountRelabel(prisma, 'acct-1')
    const existing = await prisma.analysisWorkItem.findFirstOrThrow({
      where: { triggerId: 'acct-1' },
    })
    await prisma.analysisWorkItem.update({
      where: { id: existing.id },
      data: {
        status: 'leased',
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 1000),
        attemptCount: 5,
        maxAttempts: 5,
      },
    })

    const result = await recoverExhaustedExpiredWorkItems(prisma, {
      kind: 'account_relabel',
      batchSize: 10,
    })

    expect(result).toEqual({ reArmed: 0, parkedAsFailed: 1 })
    const item = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
    expect(item.status).toBe('failed')
    expect(item.leaseOwner).toBeNull()
    expect(item.leaseExpiresAt).toBeNull()

    // failed に park された行は、後続の正当な request で改めて queued に再 arm できる。
    await requestAccountRelabel(prisma, 'acct-1')
    const rearmed = await prisma.analysisWorkItem.findUniqueOrThrow({ where: { id: existing.id } })
    expect(rearmed.status).toBe('queued')
    expect(rearmed.attemptCount).toBe(0)
  })

  it('lease がまだ有効な行や attemptCount が残っている行には触れない', async () => {
    await requestAccountRelabel(prisma, 'acct-1')
    const active = await prisma.analysisWorkItem.findFirstOrThrow({
      where: { triggerId: 'acct-1' },
    })
    await prisma.analysisWorkItem.update({
      where: { id: active.id },
      data: {
        status: 'leased',
        leaseOwner: 'live-worker',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        attemptCount: 5,
        maxAttempts: 5,
      },
    })

    await requestAccountRelabel(prisma, 'acct-2')
    const notExhausted = await prisma.analysisWorkItem.findFirstOrThrow({
      where: { triggerId: 'acct-2' },
    })
    await prisma.analysisWorkItem.update({
      where: { id: notExhausted.id },
      data: {
        status: 'leased',
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 1000),
        attemptCount: 2,
        maxAttempts: 5,
      },
    })

    const result = await recoverExhaustedExpiredWorkItems(prisma, {
      kind: 'account_relabel',
      batchSize: 10,
    })

    expect(result).toEqual({ reArmed: 0, parkedAsFailed: 0 })
  })

  it('batchSize を超える対象は 1 回で処理しきらず次回以降に持ち越す', async () => {
    await requestAccountRelabelBulk(prisma, ['acct-1', 'acct-2', 'acct-3'])
    const items = await prisma.analysisWorkItem.findMany({ where: { triggerType: 'account' } })
    for (const item of items) {
      await prisma.analysisWorkItem.update({
        where: { id: item.id },
        data: {
          status: 'leased',
          leaseOwner: 'dead-worker',
          leaseExpiresAt: new Date(Date.now() - 1000),
          attemptCount: 5,
          maxAttempts: 5,
        },
      })
    }

    const firstBatch = await recoverExhaustedExpiredWorkItems(prisma, {
      kind: 'account_relabel',
      batchSize: 2,
    })
    expect(firstBatch.reArmed + firstBatch.parkedAsFailed).toBe(2)

    const secondBatch = await recoverExhaustedExpiredWorkItems(prisma, {
      kind: 'account_relabel',
      batchSize: 2,
    })
    expect(secondBatch.reArmed + secondBatch.parkedAsFailed).toBe(1)
  })

  it('re-arm した item は同じ cycle 内の peekWorkItemCandidates ですぐ拾える', async () => {
    await requestAccountRelabel(prisma, 'acct-1')
    const existing = await prisma.analysisWorkItem.findFirstOrThrow({
      where: { triggerId: 'acct-1' },
    })
    await prisma.analysisWorkItem.update({
      where: { id: existing.id },
      data: {
        status: 'leased',
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 1000),
        attemptCount: 5,
        maxAttempts: 5,
        staleRequestedAt: new Date(),
      },
    })

    const recovered = await recoverExhaustedExpiredWorkItems(prisma, {
      kind: 'account_relabel',
      batchSize: 10,
    })
    expect(recovered.reArmed).toBe(1)

    // availableAt は DB の now() で書かれ、peek は JS の時刻と比較する。
    // 実時計同士の比較だとミリ秒の前後で結果が変わるため、JS 側の時刻だけ固定する。
    const rearmed = await prisma.analysisWorkItem.findFirstOrThrow({ where: { id: existing.id } })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(rearmed.availableAt.getTime() + 1000))
      const candidates = await peekWorkItemCandidates(prisma, {
        kinds: ['account_relabel'],
        limit: 10,
      })
      expect(candidates.map((c) => c.id)).toEqual([existing.id])
    } finally {
      vi.useRealTimers()
    }
  })
})

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
      { id: 1, triggerId: 'alice' },
      { id: 2, triggerId: 'bob' },
    ])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await peekWorkItemCandidates(prisma, {
      kinds: ['account_relabel'],
      limit: 10,
    })

    expect(result).toEqual([
      { id: 1, triggerId: 'alice' },
      { id: 2, triggerId: 'bob' },
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
    const claimedRow = { id: 1, triggerId: 'alice', status: 'leased' }
    const queryRaw = vi.fn().mockResolvedValue([claimedRow])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await claimWorkItemBatchByIds(prisma, {
      ids: [1, 2],
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

describe('completeAccountRelabelWorkItemsBulk (mock)', () => {
  it('workItemIds が空の場合は DB へ問い合わせず空配列を返す', async () => {
    const queryRaw = vi.fn()
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await completeAccountRelabelWorkItemsBulk(prisma, {
      workItemIds: [],
      leaseOwner: 'worker-1',
    })

    expect(result).toEqual([])
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('id = ANY(...) と leaseOwner 一致を条件に 1 回の UPDATE でまとめて完了させる', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { id: 1, status: 'succeeded' },
      { id: 2, status: 'queued' },
    ])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const result = await completeAccountRelabelWorkItemsBulk(prisma, {
      workItemIds: [1, 2, 3],
      leaseOwner: 'worker-1',
    })

    // wi-3 は結果に含まれない = lease を失っていた ('lease_lost' 相当)。
    expect(result).toEqual([
      { id: 1, status: 'succeeded' },
      { id: 2, status: 'requeued' },
    ])
    expect(queryRaw).toHaveBeenCalledTimes(1)
    const sql = (queryRaw.mock.calls[0][0] as unknown[]).join('')
    expect(sql).toContain('"id" = ANY(')
    expect(sql).toContain('"leaseOwner" = ')
  })
})

describe.skipIf(!process.env.DATABASE_URL)(
  'peekWorkItemCandidates / claimWorkItemBatchByIds (DB)',
  () => {
    const prisma = getPrismaClient()

    beforeEach(async () => {
      await prisma.analysisWorkItem.deleteMany()
      await prisma.analysisWorkItemDone.deleteMany()
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
