import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import {
  MAX_CLUSTER_RELABEL_REQUESTS_PER_CYCLE,
  relabelGrownBioClusters,
} from './bio-duplicate-cluster-size-repository'
import { requestAccountRelabelBulk } from './analysis-work-item-repository'
import { filterAccountIdsWithExistingLabels } from './label-repository'

vi.mock('./analysis-work-item-repository', () => ({ requestAccountRelabelBulk: vi.fn() }))
vi.mock('./label-repository', () => ({ filterAccountIdsWithExistingLabels: vi.fn() }))

const BIO = 'fictional template bio for cluster tests one'
const OTHER_BIO = 'fictional template bio for cluster tests two'

function corpus(bio: string, count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({ accountId: `${prefix}${i}`, bio }))
}

interface FakeRow {
  clusterKey: string
  size: number
  memberIds: string[]
}

// 永続テーブルをメモリで模す。
function createFakePrisma() {
  const store = new Map<string, { size: number; memberIds: string[] }>()
  const prisma = {
    bioDuplicateClusterSize: {
      findMany: vi.fn(() =>
        Promise.resolve([...store].map(([clusterKey, row]) => ({ clusterKey, ...row }))),
      ),
      deleteMany: vi.fn(() => ({ data: undefined })),
      createMany: vi.fn((args: { data: FakeRow[] }) => args),
    },
    $transaction: vi.fn((ops: { data?: FakeRow[] }[]) => {
      for (const op of ops) {
        if (op.data) {
          for (const row of op.data) {
            store.set(row.clusterKey, { size: row.size, memberIds: row.memberIds })
          }
        } else store.clear()
      }
      return Promise.resolve()
    }),
  }
  return { prisma: prisma as unknown as PrismaClient, store }
}

describe('relabelGrownBioClusters', () => {
  beforeEach(() => {
    vi.mocked(requestAccountRelabelBulk).mockReset()
    vi.mocked(filterAccountIdsWithExistingLabels).mockReset()
    vi.mocked(filterAccountIdsWithExistingLabels).mockImplementation((_prisma, ids) =>
      Promise.resolve(new Set(ids)),
    )
  })

  it('初回は要求せずサイズだけ永続化する', async () => {
    const { prisma, store } = createFakePrisma()
    expect(await relabelGrownBioClusters(prisma, corpus(BIO, 6, 'a'))).toBe(0)
    expect(requestAccountRelabelBulk).not.toHaveBeenCalled()
    expect(store.size).toBe(1)
  })

  it('閾値を跨いだクラスタの既存ラベル付きアカウントへ要求する', async () => {
    const { prisma } = createFakePrisma()
    await relabelGrownBioClusters(prisma, [...corpus(BIO, 5, 'a'), ...corpus(OTHER_BIO, 2, 'b')])
    vi.mocked(filterAccountIdsWithExistingLabels).mockImplementation((_prisma, ids) =>
      Promise.resolve(new Set(ids.slice(0, 3))),
    )
    const requested = await relabelGrownBioClusters(prisma, [
      ...corpus(BIO, 6, 'a'),
      ...corpus(OTHER_BIO, 2, 'b'),
    ])
    expect(requested).toBe(3)
    expect(vi.mocked(requestAccountRelabelBulk).mock.calls[0][1]).toHaveLength(3)
  })

  it('跨いでいない更新では要求しない', async () => {
    const { prisma } = createFakePrisma()
    await relabelGrownBioClusters(prisma, corpus(BIO, 4, 'a'))
    expect(await relabelGrownBioClusters(prisma, corpus(BIO, 5, 'a'))).toBe(0)
    expect(requestAccountRelabelBulk).not.toHaveBeenCalled()
  })

  it('再実行しても同じクラスタを重複要求しない', async () => {
    const { prisma } = createFakePrisma()
    await relabelGrownBioClusters(prisma, corpus(BIO, 5, 'a'))
    await relabelGrownBioClusters(prisma, corpus(BIO, 6, 'a'))
    expect(await relabelGrownBioClusters(prisma, corpus(BIO, 6, 'a'))).toBe(0)
    expect(requestAccountRelabelBulk).toHaveBeenCalledTimes(1)
  })

  it('上限を超えるクラスタは要求せず、次サイクルで再び対象になる', async () => {
    const { prisma } = createFakePrisma()
    await relabelGrownBioClusters(prisma, corpus(BIO, 5, 'a'))
    expect(await relabelGrownBioClusters(prisma, corpus(BIO, 6, 'a'), 5)).toBe(0)
    expect(requestAccountRelabelBulk).not.toHaveBeenCalled()
    expect(await relabelGrownBioClusters(prisma, corpus(BIO, 6, 'a'), 6)).toBe(6)
  })

  it('閾値以上に縮小したクラスタは、縮小前のメンバーのうち既存ラベル付きへ要求する', async () => {
    const { prisma } = createFakePrisma()
    await relabelGrownBioClusters(prisma, corpus(BIO, 6, 'a'))
    vi.mocked(filterAccountIdsWithExistingLabels).mockImplementation((_prisma, ids) =>
      Promise.resolve(new Set(ids.slice(0, 4))),
    )
    const requested = await relabelGrownBioClusters(prisma, corpus(BIO, 3, 'a'))
    expect(requested).toBe(4)
    expect(vi.mocked(requestAccountRelabelBulk).mock.calls[0][1]).toHaveLength(4)
  })

  it('クラスタが消滅した場合も縮小前のメンバーへ要求する', async () => {
    const { prisma } = createFakePrisma()
    await relabelGrownBioClusters(prisma, corpus(BIO, 6, 'a'))
    expect(await relabelGrownBioClusters(prisma, corpus(OTHER_BIO, 2, 'b'))).toBe(6)
  })

  it('閾値以上のクラスタだけがメンバー ID を永続化する', async () => {
    const { prisma, store } = createFakePrisma()
    await relabelGrownBioClusters(prisma, [...corpus(BIO, 6, 'a'), ...corpus(OTHER_BIO, 2, 'b')])
    const rows = [...store.values()]
    expect(rows.find((row) => row.size === 6)?.memberIds).toHaveLength(6)
    expect(rows.find((row) => row.size === 2)?.memberIds).toEqual([])
  })

  it('縮小の再ラベルを再実行しても重複要求しない', async () => {
    const { prisma } = createFakePrisma()
    await relabelGrownBioClusters(prisma, corpus(BIO, 6, 'a'))
    await relabelGrownBioClusters(prisma, corpus(BIO, 3, 'a'))
    expect(await relabelGrownBioClusters(prisma, corpus(BIO, 3, 'a'))).toBe(0)
    expect(requestAccountRelabelBulk).toHaveBeenCalledTimes(1)
  })

  it('メンバー ID を持たない既存行の縮小は要求しない', async () => {
    const { prisma, store } = createFakePrisma()
    await relabelGrownBioClusters(prisma, corpus(BIO, 6, 'a'))
    for (const row of store.values()) row.memberIds = []
    expect(await relabelGrownBioClusters(prisma, corpus(BIO, 3, 'a'))).toBe(0)
    expect(requestAccountRelabelBulk).not.toHaveBeenCalled()
  })

  it('縮小の要求が上限を超える場合は据え置き、次サイクルで再び対象になる', async () => {
    const { prisma } = createFakePrisma()
    await relabelGrownBioClusters(prisma, corpus(BIO, 6, 'a'))
    expect(await relabelGrownBioClusters(prisma, corpus(OTHER_BIO, 2, 'b'), 5)).toBe(0)
    expect(requestAccountRelabelBulk).not.toHaveBeenCalled()
    expect(await relabelGrownBioClusters(prisma, corpus(OTHER_BIO, 2, 'b'), 6)).toBe(6)
  })

  it('既定の上限は正の値である', () => {
    expect(MAX_CLUSTER_RELABEL_REQUESTS_PER_CYCLE).toBeGreaterThan(0)
  })
})
