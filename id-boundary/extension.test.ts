import { describe, expect, it, vi } from 'vitest'
import { createIdBoundaryExtension, type DmmfSource } from './extension'

const scalar = (name: string, type: string) => ({ name, kind: 'scalar', type })
const relation = (name: string, type: string) => ({ name, kind: 'object', type })

const source: DmmfSource = {
  dmmf: {
    datamodel: {
      models: [
        {
          name: 'Account',
          fields: [
            scalar('id', 'BigInt'),
            scalar('screenName', 'String'),
            scalar('followersCount', 'Int'),
            relation('tweets', 'Tweet'),
          ],
        },
        {
          name: 'Tweet',
          fields: [
            scalar('id', 'BigInt'),
            scalar('accountId', 'BigInt'),
            scalar('inReplyToTweetId', 'BigInt'),
            scalar('fullText', 'String'),
            scalar('replyIds', 'BigInt'),
            scalar('meta', 'Json'),
            relation('account', 'Account'),
          ],
        },
        {
          name: 'Checkpoint',
          fields: [scalar('accountId', 'BigInt'), scalar('data', 'Json'), scalar('note', 'String')],
        },
      ],
    },
  },
}

const extension = createIdBoundaryExtension(source)

async function run(model: string, args: unknown, result: unknown = null) {
  const query = vi.fn().mockResolvedValue(result)
  const output = await extension.query.$allModels.$allOperations({
    model,
    operation: 'findMany',
    args,
    query,
  })
  return { output, passed: query.mock.calls[0]?.[0] as unknown }
}

describe('引数の変換 (文字列から bigint)', () => {
  it('where のスカラー、in、フィルタ演算子、not を変換する', async () => {
    const { passed } = await run('Tweet', {
      where: {
        accountId: '10',
        id: { in: ['1', '2'], not: { equals: '3' }, gt: '0' },
        inReplyToTweetId: null,
      },
    })
    expect(passed).toStrictEqual({
      where: {
        accountId: 10n,
        id: { in: [1n, 2n], not: { equals: 3n }, gt: 0n },
        inReplyToTweetId: null,
      },
    })
  })

  it('AND / OR / NOT と関連モデルの条件を辿る', async () => {
    const { passed } = await run('Account', {
      where: {
        OR: [{ id: '1' }, { tweets: { some: { id: '2', account: { is: { id: '3' } } } } }],
        NOT: { id: { in: ['4'] } },
      },
    })
    expect(passed).toStrictEqual({
      where: {
        OR: [{ id: 1n }, { tweets: { some: { id: 2n, account: { is: { id: 3n } } } } }],
        NOT: { id: { in: [4n] } },
      },
    })
  })

  it('BigInt 以外の文字列列と Int 列は変換しない', async () => {
    const { passed } = await run('Account', {
      where: { screenName: { contains: '123' }, followersCount: { gt: 5 } },
    })
    expect(passed).toStrictEqual({
      where: { screenName: { contains: '123' }, followersCount: { gt: 5 } },
    })
  })

  it('Json 列の中の ID は文字列のまま残す', async () => {
    const { passed } = await run('Checkpoint', {
      data: { accountId: '5', data: { ids: ['1', '2'] }, note: '7' },
    })
    expect(passed).toStrictEqual({
      data: { accountId: 5n, data: { ids: ['1', '2'] }, note: '7' },
    })
  })

  it('create / update / upsert / createMany の data を変換する', async () => {
    const { passed } = await run('Tweet', {
      where: { id: '1' },
      create: { id: '1', accountId: '2', account: { connect: { id: '2' } } },
      update: { inReplyToTweetId: { set: '9' } },
      data: [{ id: '5', accountId: '6' }],
    })
    expect(passed).toStrictEqual({
      where: { id: 1n },
      create: { id: 1n, accountId: 2n, account: { connect: { id: 2n } } },
      update: { inReplyToTweetId: { set: 9n } },
      data: [{ id: 5n, accountId: 6n }],
    })
  })

  it('スカラーリスト列の set と配列を変換する', async () => {
    const { passed } = await run('Tweet', {
      data: { replyIds: ['1', '2'] },
      where: { replyIds: { has: '1' } },
    })
    expect(passed).toStrictEqual({ data: { replyIds: [1n, 2n] }, where: { replyIds: { has: 1n } } })
  })

  it('select / include 内の関連モデルの引数も変換する', async () => {
    const { passed } = await run('Account', {
      include: { tweets: { where: { id: { in: ['7'] } }, take: 3, select: { id: true } } },
      select: { _count: { select: { tweets: { where: { accountId: '8' } } } } },
    })
    expect(passed).toStrictEqual({
      include: { tweets: { where: { id: { in: [7n] } }, take: 3, select: { id: true } } },
      select: { _count: { select: { tweets: { where: { accountId: 8n } } } } },
    })
  })

  it('cursor を変換し、orderBy と take はそのまま渡す', async () => {
    const { passed } = await run('Account', {
      cursor: { id: '5' },
      orderBy: { id: 'asc' },
      take: 10,
    })
    expect(passed).toStrictEqual({ cursor: { id: 5n }, orderBy: { id: 'asc' }, take: 10 })
  })

  it('bigint と number はそのまま渡す', async () => {
    const { passed } = await run('Tweet', { where: { id: 5n, accountId: 6 } })
    expect(passed).toStrictEqual({ where: { id: 5n, accountId: 6 } })
  })

  it('args が undefined でも動く', async () => {
    const { passed } = await run('Account', undefined)
    expect(passed).toBeUndefined()
  })

  it('非数値の ID を拒否し、クエリを実行しない', async () => {
    const query = vi.fn()
    await expect(
      extension.query.$allModels.$allOperations({
        model: 'Tweet',
        operation: 'findMany',
        args: { where: { accountId: { in: ['1', 'abc'] } } },
        query,
      }),
    ).rejects.toThrow('Invalid id string "abc": must be a decimal integer without leading zeros')
    expect(query).not.toHaveBeenCalled()
  })

  it('未知のモデルを拒否する', async () => {
    await expect(run('Nope', { where: { id: '1' } })).rejects.toThrow('Unknown Prisma model "Nope"')
  })
})

describe('戻り値の変換 (bigint から文字列)', () => {
  it('行の bigint を文字列にし、null と Date と数値は保つ', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const { output } = await run('Tweet', {}, [
      {
        id: 9_007_199_254_740_993n,
        accountId: 1n,
        inReplyToTweetId: null,
        createdAt,
        fullText: 'x',
      },
    ])
    expect(output).toStrictEqual([
      { id: '9007199254740993', accountId: '1', inReplyToTweetId: null, createdAt, fullText: 'x' },
    ])
  })

  it('スカラーリスト列と関連モデルの bigint を文字列にする', async () => {
    const { output } = await run(
      'Account',
      {},
      {
        id: 1n,
        tweets: [{ id: 2n, replyIds: [3n, 4n], account: { id: 1n } }],
      },
    )
    expect(output).toStrictEqual({
      id: '1',
      tweets: [{ id: '2', replyIds: ['3', '4'], account: { id: '1' } }],
    })
  })

  it('集計と groupBy の _max と _count を変換する', async () => {
    const { output } = await run('Tweet', {}, { _max: { id: 10n }, _count: { _all: 3 } })
    expect(output).toStrictEqual({ _max: { id: '10' }, _count: { _all: 3 } })
  })

  it('null の結果はそのまま返す', async () => {
    const { output } = await run('Account', {}, null)
    expect(output).toBeNull()
  })

  it('Json 列の中身は走査せずそのまま返す', async () => {
    const meta = { nested: { value: 1 } }
    const { output } = (await run('Tweet', {}, { id: 1n, meta })) as { output: { meta: unknown } }
    expect(output.meta).toBe(meta)
  })
})
