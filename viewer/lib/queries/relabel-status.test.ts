import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getRelabelStatus } from './relabel-status'

describe('getRelabelStatus', () => {
  it('スナップショットの現行 versionNo の件数を coverage とし、版の文字列は LabelRuleVersion から引く', async () => {
    const snapshotFindMany = vi.fn().mockResolvedValue([
      {
        labelDefinitionId: 1,
        versionNo: 2,
        accountCount: 30,
        computedAt: new Date('2026-08-11T01:00:00Z'),
      },
      {
        labelDefinitionId: 1,
        versionNo: 1,
        accountCount: 5,
        computedAt: new Date('2026-08-11T01:00:00Z'),
      },
    ])
    const definitionFindMany = vi.fn().mockResolvedValue([
      {
        id: 1,
        key: 'topic_food',
        description: 'desc',
        currentRuleVersionNo: 2,
        ruleVersions: [
          { versionNo: 1, ruleVersion: '0.9.0' },
          { versionNo: 2, ruleVersion: '1.0.0' },
        ],
      },
    ])
    const prisma = {
      account: { count: vi.fn().mockResolvedValue(100) },
      labelDefinition: { findMany: definitionFindMany },
      relabelCoverageSnapshot: { findMany: snapshotFindMany },
      analysisWorkItem: {
        groupBy: vi.fn().mockResolvedValue([
          { status: 'queued', _count: 5 },
          { status: 'leased', _count: 2 },
        ]),
      },
      relabelScanCursor: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'singleton',
          lastScannedAccountId: '1',
          updatedAt: new Date('2026-08-11T00:00:00Z'),
        }),
      },
    } as unknown as PrismaClient

    const status = await getRelabelStatus(prisma)

    expect(definitionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { retiredAt: null } }),
    )
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
    expect(status.coverageComputedAt).toEqual(new Date('2026-08-11T01:00:00Z'))
  })

  it('現行の versionNo が未設定の label は 0 件表示にし、スナップショットが無ければ作成時刻は null', async () => {
    const prisma = {
      account: { count: vi.fn().mockResolvedValue(100) },
      labelDefinition: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 2,
            key: 'topic_new',
            description: 'desc',
            currentRuleVersionNo: null,
            ruleVersions: [],
          },
        ]),
      },
      relabelCoverageSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
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
    expect(status.coverageComputedAt).toBeNull()
  })

  it('現行版のスナップショット行が無い label は 0 件表示にする', async () => {
    const prisma = {
      account: { count: vi.fn().mockResolvedValue(10) },
      labelDefinition: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 3,
            key: 'just_bumped',
            description: 'desc',
            currentRuleVersionNo: 2,
            ruleVersions: [
              { versionNo: 1, ruleVersion: '1.0.0' },
              { versionNo: 2, ruleVersion: '2.0.0' },
            ],
          },
        ]),
      },
      relabelCoverageSnapshot: {
        findMany: vi.fn().mockResolvedValue([
          {
            labelDefinitionId: 3,
            versionNo: 1,
            accountCount: 10,
            computedAt: new Date('2026-08-11T01:00:00Z'),
          },
        ]),
      },
      analysisWorkItem: { groupBy: vi.fn().mockResolvedValue([]) },
      relabelScanCursor: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient

    const status = await getRelabelStatus(prisma)

    expect(status.labelCoverage[0]).toMatchObject({
      currentRuleVersion: '2.0.0',
      coveredAccounts: 0,
    })
  })
})
