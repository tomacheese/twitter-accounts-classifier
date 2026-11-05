import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getRelabelStatus } from './relabel-status'

describe('getRelabelStatus', () => {
  it('value に関係なく currentRuleVersion 一致件数を coverage として数える', async () => {
    const groupByLabelLatest = vi.fn().mockResolvedValue([
      { labelDefinitionId: 1, ruleVersion: '1.0.0', _count: 30 },
      { labelDefinitionId: 1, ruleVersion: '0.9.0', _count: 5 },
    ])
    const prisma = {
      account: { count: vi.fn().mockResolvedValue(100) },
      labelDefinition: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 1,
            key: 'topic_food',
            description: 'desc',
            currentRuleVersion: '1.0.0',
          },
        ]),
      },
      accountLabelLatest: { groupBy: groupByLabelLatest },
      analysisWorkItem: {
        groupBy: vi.fn().mockResolvedValue([
          { status: 'queued', _count: 5 },
          { status: 'leased', _count: 2 },
        ]),
      },
      relabelScanCursor: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'singleton',
          lastScannedAccountId: 'alice',
          updatedAt: new Date('2026-08-11T00:00:00Z'),
        }),
      },
    } as unknown as PrismaClient

    const status = await getRelabelStatus(prisma)

    expect(groupByLabelLatest).toHaveBeenCalledWith({
      by: ['labelDefinitionId', 'ruleVersion'],
      _count: true,
    })
    expect(status.labelCoverage).toEqual([
      {
        key: 'topic_food',
        description: 'desc',
        currentRuleVersion: '1.0.0',
        coveredAccounts: 30,
        totalAccounts: 100,
      },
    ])
    expect(status.backlog).toEqual([
      { status: 'queued', count: 5 },
      { status: 'leased', count: 2 },
    ])
    expect(status.scanCursorUpdatedAt).toEqual(new Date('2026-08-11T00:00:00Z'))
  })

  it('currentRuleVersion が未設定の label は 0 件表示にする', async () => {
    const prisma = {
      account: { count: vi.fn().mockResolvedValue(100) },
      labelDefinition: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 2,
            key: 'topic_new',
            description: 'desc',
            currentRuleVersion: null,
          },
        ]),
      },
      accountLabelLatest: { groupBy: vi.fn().mockResolvedValue([]) },
      analysisWorkItem: { groupBy: vi.fn().mockResolvedValue([]) },
      relabelScanCursor: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient

    const status = await getRelabelStatus(prisma)

    expect(status.labelCoverage).toEqual([
      {
        key: 'topic_new',
        description: 'desc',
        currentRuleVersion: null,
        coveredAccounts: 0,
        totalAccounts: 100,
      },
    ])
    expect(status.scanCursorUpdatedAt).toBeNull()
  })
})
