import { describe, expect, it, vi } from 'vitest'
import { encodeCursor } from '../pagination/keyset-cursor'
import type { PrismaClient } from '../../generated/prisma'
import { listReviewFindings } from './review-findings'

function createMockPrisma(rows: unknown[]) {
  return { $queryRaw: vi.fn().mockResolvedValue(rows) } as unknown as PrismaClient
}

const baseRow = {
  id: 'finding-1',
  type: 'label_count_drop',
  status: 'active',
  currentSeverity: 'high',
  primaryScopeType: 'label',
  primaryScopeId: 'label-1',
  firstDetectedAt: new Date('2026-08-01T00:00:00.000Z'),
  lastDetectedAt: new Date('2026-08-07T00:00:00.000Z'),
  recurrenceCount: 0,
  severityRank: 2,
}

describe('listReviewFindings', () => {
  it.each([
    [[]],
    [['2', 'bad', 'id']],
    [['bad', '2026-01-01T00:00:00.000Z', 'id']],
    [['2', '2026-01-01T00:00:00.000Z', '']],
  ])('不正な cursor を無視する: %j', async (sortValues) => {
    const prisma = createMockPrisma([])
    const filterHash = JSON.stringify({
      status: ['active', 'recurring'],
      severity: [],
      type: null,
      primaryScopeType: null,
    })
    await listReviewFindings(prisma, {
      filters: {},
      limit: 25,
      cursor: encodeCursor({ sortValues, filterHash }),
    })
    const firstPage = createMockPrisma([])
    await listReviewFindings(firstPage, { filters: {}, limit: 25 })
    expect((prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(
      (firstPage.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0],
    )
  })

  it('既定では active/recurring のみを対象にする WHERE を組み立てる', async () => {
    const prisma = createMockPrisma([])
    await listReviewFindings(prisma, { filters: {}, limit: 25 })

    const call = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]
    const sql = (call[0] as string[]).join('')
    expect(sql).toContain('WHERE')
  })

  it('limit を超える件数を取得したら nextCursor を返す', async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({
      ...baseRow,
      id: `finding-${index}`,
    }))
    const prisma = createMockPrisma(rows)

    const result = await listReviewFindings(prisma, { filters: {}, limit: 25 })

    expect(result.items).toHaveLength(25)
    expect(result.nextCursor).not.toBeNull()
  })

  it('limit 以下の件数なら nextCursor は null になる', async () => {
    const prisma = createMockPrisma([baseRow])

    const result = await listReviewFindings(prisma, { filters: {}, limit: 25 })

    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).toBeNull()
  })
})
