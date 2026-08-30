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

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, {
      accountIds: ['alice', 'bob'],
    })

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

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, {
      accountIds: ['alice', 'bob'],
    })

    expect(index.signalsFor('alice')).toEqual({})
  })

  it('Follow 行が無いアカウントには空の Record が返る', async () => {
    const prisma = makePrisma(
      [{ accountId: 'bob', labelDefinitionId: 'def-topic_food', labeledCount: 1, totalCount: 1 }],
      [],
    )
    const labelKeyToDefinitionId = new Map([['topic_food', 'def-topic_food']])

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, {
      accountIds: ['alice', 'bob'],
    })

    expect(index.signalsFor('alice')).toEqual({})
  })

  it('labelKeyToDefinitionId に無い labelDefinitionId の集計行は signalsFor の結果から除外される', async () => {
    const prisma = makePrisma(
      [{ accountId: 'alice', labelDefinitionId: 'def-unknown', labeledCount: 5, totalCount: 15 }],
      [],
    )
    const labelKeyToDefinitionId = new Map([['topic_food', 'def-topic_food']])

    const index = await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, {
      accountIds: ['alice', 'bob'],
    })

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

    const building = buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, {
      accountIds: ['alice', 'bob'],
    })
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

    await buildFollowGraphLabelIndex(prisma, labelKeyToDefinitionId, {
      accountIds: ['alice', 'bob'],
    })

    const followeeQuerySql = (queryRaw.mock.calls[0][0] as unknown[]).join('')
    expect(followeeQuerySql).toContain('"LabelingFollowSample"')
  })

  it('フォロー先方向では sample を優先して重複 Follow edge を anti join し UNION ALL する', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_food', 'def-topic_food']]), {
      accountIds: ['alice'],
    })

    const followeeQuerySql = (queryRaw.mock.calls[0][0] as unknown[]).join('')
    expect(followeeQuerySql).toContain('UNION ALL')
    expect(followeeQuerySql).toContain('NOT EXISTS')
    expect(followeeQuerySql).toContain('sample."accountId" = f."followerId"')
  })
})

describe('buildFollowGraphLabelIndex label filtering', () => {
  it('filters both queries by labelDefinitionId when given a restricted map', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_anime', 'ld-anime']]), {
      accountIds: ['alice'],
    })

    expect(queryRaw).toHaveBeenCalledTimes(2)
    for (const call of queryRaw.mock.calls) {
      const sql = (call[0] as unknown[]).join('')
      expect(sql).toContain('unnest(')
      expect(sql).toContain('target."labelDefinitionId"')
      const targetIds = call.slice(1).find((v) => Array.isArray(v) && v[0] === 'ld-anime') as
        string[] | undefined
      expect(targetIds).toEqual(['ld-anime'])
    }
  })

  it('returns an empty index without querying when the label map is empty', async () => {
    const queryRaw = vi.fn()
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const index = await buildFollowGraphLabelIndex(prisma, new Map(), { accountIds: ['alice'] })

    expect(queryRaw).not.toHaveBeenCalled()
    expect(index.signalsFor('any')).toEqual({})
  })

  it('filters both queries by accountIds when the option is given', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_food', 'ld-food']]), {
      accountIds: ['alice', 'bob'],
    })

    expect(queryRaw).toHaveBeenCalledTimes(2)
    for (const call of queryRaw.mock.calls) {
      const sql = (call[0] as unknown[]).join('')
      expect(sql).toContain('= ANY(')
    }
  })

  it('フォロー先方向のクエリは accountId 絞り込みを AccountLabelLatest への参照より前 (edges 内) に書く', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_food', 'ld-food']]), {
      accountIds: ['alice', 'bob'],
    })

    const followeeQuerySql = (queryRaw.mock.calls[0][0] as unknown[]).join('')
    const edgesSubquerySql = followeeQuerySql.slice(
      followeeQuerySql.indexOf('FROM (') + 'FROM ('.length,
      followeeQuerySql.indexOf(') edges'),
    )
    expect(edgesSubquerySql).toContain('= ANY(')
    expect(followeeQuerySql.indexOf('JOIN "AccountLabelLatest"')).toBeGreaterThan(
      followeeQuerySql.indexOf(') edges'),
    )
  })

  it('フォロー先方向のクエリは AccountLabelLatest 参照を unnest した labelDefinitionId との等価 JOIN にし、PK 2列とも Index Cond に使わせる形へ LATERAL/OFFSET 0 で固定する', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_food', 'ld-food']]), {
      accountIds: ['alice', 'bob'],
    })

    const followeeQuerySql = (queryRaw.mock.calls[0][0] as unknown[]).join('')
    expect(followeeQuerySql).toContain('CROSS JOIN LATERAL')
    expect(followeeQuerySql).toContain('FROM unnest(')
    expect(followeeQuerySql).toContain('AS target("labelDefinitionId")')
    expect(followeeQuerySql).toContain('all_latest."accountId" = edges."followeeId"')
    expect(followeeQuerySql).toContain(
      'all_latest."labelDefinitionId" = target."labelDefinitionId"',
    )
    expect(followeeQuerySql).toContain('OFFSET 0')
    expect(followeeQuerySql).not.toContain('"labelDefinitionId" IN')
  })

  it('フォロワー方向のクエリも AccountLabelLatest 参照を unnest した labelDefinitionId との等価 JOIN にし、PK 2列とも Index Cond に使わせる形へ LATERAL/OFFSET 0 で固定する', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_food', 'ld-food']]), {
      accountIds: ['alice', 'bob'],
    })

    const followerQuerySql = (queryRaw.mock.calls[1][0] as unknown[]).join('')
    expect(followerQuerySql).toContain('CROSS JOIN LATERAL')
    expect(followerQuerySql).toContain('FROM unnest(')
    expect(followerQuerySql).toContain('AS target("labelDefinitionId")')
    expect(followerQuerySql).toContain('all_latest."accountId" = f."followerId"')
    expect(followerQuerySql).toContain(
      'all_latest."labelDefinitionId" = target."labelDefinitionId"',
    )
    expect(followerQuerySql).toContain('OFFSET 0')
    expect(followerQuerySql).not.toContain('"labelDefinitionId" IN')
  })

  it('does not filter by accountIds when the option is omitted', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_food', 'ld-food']]))

    expect(queryRaw).toHaveBeenCalledTimes(2)
    for (const call of queryRaw.mock.calls) {
      const sql = (call[0] as unknown[]).join('')
      expect(sql).not.toContain('= ANY(')
    }
  })

  it('accountIds が chunkSize を超える場合、chunk ごとに直列でクエリを実行し結果をマージする', async () => {
    const followeeCalls: unknown[][] = []
    const followerCalls: unknown[][] = []
    const queryRaw = vi.fn().mockImplementation((strings: unknown, ...values: unknown[]) => {
      const sql = Array.isArray(strings) ? strings.join('') : ''
      if (sql.includes('"followerId" AS "accountId"')) {
        followeeCalls.push(values)
        return Promise.resolve([
          {
            accountId:
              (values.find((v) => Array.isArray(v)) as string[] | undefined)?.[0] ?? 'unknown',
            labelDefinitionId: 'ld-food',
            labeledCount: 1,
            totalCount: 1,
          },
        ])
      }
      followerCalls.push(values)
      return Promise.resolve([])
    })
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    const index = await buildFollowGraphLabelIndex(prisma, new Map([['topic_food', 'ld-food']]), {
      accountIds: ['alice', 'bob', 'carol'],
      chunkSize: 2,
    })

    // chunk size 2 に対し 3 件の accountIds なので、chunk は [alice, bob] と [carol] の2つに分かれる。
    expect(followeeCalls).toHaveLength(2)
    expect(followerCalls).toHaveLength(2)
    expect(index.signalsFor('alice').topic_food.followeeLabeledCount).toBe(1)
  })

  it('accountIds が chunkSize ちょうどの場合、1 chunk だけで処理する', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_food', 'ld-food']]), {
      accountIds: ['alice', 'bob'],
      chunkSize: 2,
    })

    expect(queryRaw).toHaveBeenCalledTimes(2)
  })

  it('chunkSize を省略した場合は分割せず1回で処理する', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient

    await buildFollowGraphLabelIndex(prisma, new Map([['topic_food', 'ld-food']]), {
      accountIds: ['alice', 'bob', 'carol'],
    })

    expect(queryRaw).toHaveBeenCalledTimes(2)
  })
})
