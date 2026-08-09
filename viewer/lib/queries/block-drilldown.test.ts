import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getBlockAccountRunsWithActions } from './block-drilldown'

function createMockPrisma(overrides: {
  accountRuns?: unknown[]
  actions?: unknown[]
  labelDefinitions?: unknown[]
  outboxEntries?: unknown[]
}) {
  const accountRunFindMany = vi.fn().mockResolvedValue(overrides.accountRuns ?? [])
  const actionFindMany = vi.fn().mockResolvedValue(overrides.actions ?? [])
  const labelDefinitionFindMany = vi.fn().mockResolvedValue(overrides.labelDefinitions ?? [])
  const outboxEntryFindMany = vi.fn().mockResolvedValue(overrides.outboxEntries ?? [])
  return {
    prisma: {
      blockAccountRun: { findMany: accountRunFindMany },
      blockAction: { findMany: actionFindMany },
      labelDefinition: { findMany: labelDefinitionFindMany },
      blockOutboxEntry: { findMany: outboxEntryFindMany },
    } as unknown as PrismaClient,
    accountRunFindMany,
    actionFindMany,
    labelDefinitionFindMany,
    outboxEntryFindMany,
  }
}

describe('getBlockAccountRunsWithActions', () => {
  it('BlockAccountRun と BlockAction (label key 解決済み) を結合して返す', async () => {
    const { prisma } = createMockPrisma({
      accountRuns: [
        {
          id: 'bar-1',
          username: 'alice',
          candidatesCount: 2,
          blockedCount: 1,
          failedCount: 1,
          status: 'partial',
        },
      ],
      actions: [
        {
          id: 'ba-1',
          blockAccountRunId: 'bar-1',
          blockedId: 'account-2',
          labelDefinitionId: 'label-1',
          confidence: 0.9,
          result: 'success',
          errorMessage: null,
          outboxEntryId: 'outbox-1',
        },
      ],
      labelDefinitions: [{ id: 'label-1', key: 'test_label' }],
      outboxEntries: [{ id: 'outbox-1', status: 'local_persisted' }],
    })

    const result = await getBlockAccountRunsWithActions(prisma, 'block-run-1')

    expect(result[0].actions[0]).toMatchObject({
      labelKey: 'test_label',
      result: 'success',
      outboxStatus: 'local_persisted',
    })
  })

  it('outboxEntryId が null の action は outboxStatus を null にする', async () => {
    const { prisma } = createMockPrisma({
      accountRuns: [
        {
          id: 'bar-1',
          username: 'bob',
          candidatesCount: 1,
          blockedCount: 0,
          failedCount: 1,
          status: 'failed',
        },
      ],
      actions: [
        {
          id: 'ba-2',
          blockAccountRunId: 'bar-1',
          blockedId: 'account-3',
          labelDefinitionId: 'label-1',
          confidence: 0.5,
          result: 'failed',
          errorMessage: 'boom',
          outboxEntryId: null,
        },
      ],
      labelDefinitions: [{ id: 'label-1', key: 'test_label' }],
      outboxEntries: [],
    })

    const result = await getBlockAccountRunsWithActions(prisma, 'block-run-1')

    expect(result[0].actions[0]).toMatchObject({
      labelKey: 'test_label',
      result: 'failed',
      errorMessage: 'boom',
      outboxStatus: null,
    })
  })

  it('同じ username の BlockAccountRun が複数あれば最新の 1 件だけ返す', async () => {
    const { prisma } = createMockPrisma({
      accountRuns: [
        {
          id: 'bar-1-old',
          username: 'alice',
          candidatesCount: 1,
          blockedCount: 0,
          failedCount: 1,
          status: 'failed',
          errorMessage: 'rate limited',
        },
        {
          id: 'bar-1-new',
          username: 'alice',
          candidatesCount: 2,
          blockedCount: 2,
          failedCount: 0,
          status: 'success',
          errorMessage: null,
        },
      ],
    })

    const result = await getBlockAccountRunsWithActions(prisma, 'block-run-1')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'bar-1-new', status: 'success' })
  })
})
