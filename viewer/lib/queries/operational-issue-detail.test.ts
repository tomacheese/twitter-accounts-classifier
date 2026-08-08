import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getOperationalIssueDetail } from './operational-issue-detail'

/**
 * @param issue - findUnique が返す OperationalIssue
 * @returns モックした Prisma クライアント
 */
function createMockPrisma(issue: unknown, sourceCycle: unknown = null): PrismaClient {
  return {
    operationalIssue: { findUnique: vi.fn().mockResolvedValue(issue) },
    operationCycle: { findUnique: vi.fn().mockResolvedValue(sourceCycle) },
  } as unknown as PrismaClient
}

describe('getOperationalIssueDetail', () => {
  it('OperationalIssue が無ければ null を返す', async () => {
    const prisma = createMockPrisma(null)
    expect(await getOperationalIssueDetail(prisma, 'missing')).toBeNull()
  })

  it('Issue 本体と観測履歴をまとめて返す', async () => {
    const firstDetectedAt = new Date('2026-01-01T00:00:00Z')
    const lastDetectedAt = new Date('2026-01-02T00:00:00Z')
    const prisma = createMockPrisma(
      {
        id: 'issue-1',
        component: 'analyzer',
        type: 'run_failure',
        status: 'active',
        severity: 'critical',
        firstDetectedAt,
        lastDetectedAt,
        resolvedAt: null,
        sourceCycleId: 'cycle-1',
        sourceStageId: null,
        occurrences: [
          {
            id: 'occurrence-1',
            observedAt: lastDetectedAt,
            stateTransition: 'reopened',
            severity: 'critical',
            sourceType: 'crawl_run',
            sourceId: 'run-1',
          },
        ],
      },
      { kind: 'block' },
    )

    const detail = await getOperationalIssueDetail(prisma, 'issue-1')

    expect(detail?.component).toBe('analyzer')
    expect(detail).toMatchObject({ sourceCycleKind: 'block' })
    expect(detail?.sourceCycleId).toBe('cycle-1')
    expect(detail?.occurrences).toHaveLength(1)
    expect(detail?.occurrences[0]?.stateTransition).toBe('reopened')
  })
})
