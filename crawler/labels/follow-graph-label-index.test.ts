import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { buildFollowGraphLabelIndex } from './follow-graph-label-index'

interface AggregateRow {
  accountId: string
  labelDefinitionId: string
  labeledCount: number
  totalCount: number
}

function makePrisma(followeeRows: AggregateRow[], followerRows: AggregateRow[]): PrismaClient {
  const queryRaw = vi.fn().mockImplementation((strings: unknown) => {
    const sql = Array.isArray(strings) ? strings.join('') : ''
    if (sql.includes('"followerId" AS "accountId"')) {
      return Promise.resolve(followeeRows)
    }
    return Promise.resolve(followerRows)
  })
  return { $queryRaw: queryRaw } as unknown as PrismaClient
}

describe('buildFollowGraphLabelIndex', () => {
  it('フォロー先方向・フォロワー方向それぞれの集計を signalsFor で読み出せる', async () => {
    const prisma = makePrisma(
      [
        {
          accountId: 'alice',
          labelDefinitionId: 'def-topic_food',
          labeledCount: 5,
          totalCount: 15,
        },
      ],
      [{ accountId: 'alice', labelDefinitionId: 'def-topic_food', labeledCount: 2, totalCount: 8 }],
    )
    const labelKeyToDefinitionId = new Map([['topic_food', 'def-topic_food']])

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, ['alice', 'bob'])

    expect(index.signalsFor('alice')).toEqual({
      topic_food: {
        followeeLabeledCount: 5,
        followeeTotalCount: 15,
        followerLabeledCount: 2,
        followerTotalCount: 8,
      },
    })
  })

  it('対象ラベルの AccountLabelLatest 行が存在しないアカウントは分母に含まれない (集計行自体が現れない)', async () => {
    const prisma = makePrisma([], [])
    const labelKeyToDefinitionId = new Map([['topic_food', 'def-topic_food']])

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, ['alice', 'bob'])

    expect(index.signalsFor('alice')).toEqual({})
  })

  it('Follow 行が無いアカウントには空の Record が返る', async () => {
    const prisma = makePrisma(
      [{ accountId: 'bob', labelDefinitionId: 'def-topic_food', labeledCount: 1, totalCount: 1 }],
      [],
    )
    const labelKeyToDefinitionId = new Map([['topic_food', 'def-topic_food']])

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, ['alice', 'bob'])

    expect(index.signalsFor('alice')).toEqual({})
  })

  it('labelKeyToDefinitionId に無い labelDefinitionId の集計行は signalsFor の結果から除外される', async () => {
    const prisma = makePrisma(
      [{ accountId: 'alice', labelDefinitionId: 'def-unknown', labeledCount: 5, totalCount: 15 }],
      [],
    )
    const labelKeyToDefinitionId = new Map([['topic_food', 'def-topic_food']])

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, ['alice', 'bob'])

    expect(index.signalsFor('alice')).toEqual({})
  })

  it('フォロー先方向の集計が完了するまでフォロワー方向の集計を開始しない', async () => {
    let resolveFollowee: ((rows: AggregateRow[]) => void) | undefined
    const followeeRows = new Promise<AggregateRow[]>((resolve) => {
      resolveFollowee = resolve
    })
    const queryRaw = vi
      .fn()
      .mockImplementationOnce(() => followeeRows)
      .mockResolvedValueOnce([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient
    const labelKeyToDefinitionId = new Map([['topic_food', 'def-topic_food']])

    const building = buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, ['alice', 'bob'])
    await Promise.resolve()

    expect(queryRaw).toHaveBeenCalledTimes(1)
    resolveFollowee?.([])
    await building
    expect(queryRaw).toHaveBeenCalledTimes(2)
  })

  it('フォロー先方向の集計クエリは Follow と LabelingFollowSample の両方を参照する', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient
    const labelKeyToDefinitionId = new Map([['topic_food', 'def-topic_food']])

    await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, ['alice', 'bob'])

    const followeeQuerySql = (queryRaw.mock.calls[0][0] as unknown[]).join('')
    expect(followeeQuerySql).toContain('"LabelingFollowSample"')
  })
})

describe('buildFollowGraphLabelIndex label filtering', () => {
  it('filters both queries by labelDefinitionId when given a restricted map', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_anime', 'ld-anime']]), ['alice'])

    expect(queryRaw).toHaveBeenCalledTimes(2)
    for (const call of queryRaw.mock.calls) {
      const sql = (call[0] as unknown[]).join('')
      expect(sql).toContain('"labelDefinitionId" IN')
      const joinedIds = call.slice(1).find((v) => (v as { values?: unknown[] }).values) as {
        values: unknown[]
      }
      expect(joinedIds.values).toEqual(['ld-anime'])
    }
  })

  it('returns an empty index without querying when the label map is empty', async () => {
    const queryRaw = vi.fn()
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const index = await buildFollowGraphLabelIndex(prisma, new Map(), ['alice'])

    expect(queryRaw).not.toHaveBeenCalled()
    expect(index.signalsFor('any')).toEqual({})
  })

  it('filters both queries by accountIds', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_anime', 'ld-anime']]), [
      'alice',
      'bob',
    ])

    expect(queryRaw).toHaveBeenCalledTimes(2)
    for (const call of queryRaw.mock.calls) {
      const sql = (call[0] as unknown[]).join('')
      expect(sql).toContain('= ANY(')
    }
  })

  it('returns an empty index without querying when accountIds is empty', async () => {
    const queryRaw = vi.fn()
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const index = await buildFollowGraphLabelIndex(
      prisma,
      new Map([['topic_anime', 'ld-anime']]),
      [],
    )

    expect(queryRaw).not.toHaveBeenCalled()
    expect(index.signalsFor('any')).toEqual({})
  })
})
