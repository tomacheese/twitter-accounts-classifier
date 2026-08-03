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

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId)

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

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId)

    expect(index.signalsFor('alice')).toEqual({})
  })

  it('Follow 行が無いアカウントには空の Record が返る', async () => {
    const prisma = makePrisma(
      [{ accountId: 'bob', labelDefinitionId: 'def-topic_food', labeledCount: 1, totalCount: 1 }],
      [],
    )
    const labelKeyToDefinitionId = new Map([['topic_food', 'def-topic_food']])

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId)

    expect(index.signalsFor('alice')).toEqual({})
  })

  it('labelKeyToDefinitionId に無い labelDefinitionId の集計行は signalsFor の結果から除外される', async () => {
    const prisma = makePrisma(
      [{ accountId: 'alice', labelDefinitionId: 'def-unknown', labeledCount: 5, totalCount: 15 }],
      [],
    )
    const labelKeyToDefinitionId = new Map([['topic_food', 'def-topic_food']])

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId)

    expect(index.signalsFor('alice')).toEqual({})
  })
})
