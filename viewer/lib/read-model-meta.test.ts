import { describe, it, expect } from 'vitest'
import { getPipelineMeta, getReadModelMeta, overlayHealthWithFreshness } from './read-model-meta'
import type { PrismaClient } from '../generated/prisma'

/**
 * getReadModelMeta/getPipelineMeta が読む範囲だけを実装したモック。
 * @param overrides - readModelState/detectionPolicyVersion の返り値
 * @returns テスト用の PrismaClient 互換オブジェクト
 */
function createMockPrisma(overrides: {
  readModelStates?: {
    modelKey: string
    lastSuccessAt: Date | null
    sourceWatermarkAt: Date | null
    currentGenerationId: string | null
    policyHash: string | null
    status: string
  }[]
  policyContent?: unknown
}): PrismaClient {
  const states = overrides.readModelStates ?? []
  return {
    readModelState: {
      findUnique: (args: { where: { modelKey: string } }) =>
        Promise.resolve(states.find((state) => state.modelKey === args.where.modelKey) ?? null),
      findMany: () => Promise.resolve(states),
    },
    detectionPolicyVersion: {
      findFirst: () =>
        Promise.resolve(
          overrides.policyContent === undefined ? null : { content: overrides.policyContent },
        ),
    },
  } as unknown as PrismaClient
}

describe('getReadModelMeta', () => {
  it('lastSuccessAt から十分経過していれば status が healthy でも stale を返す', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary',
          lastSuccessAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-1',
          policyHash: 'hash-1',
          status: 'healthy',
        },
      ],
    })

    const meta = await getReadModelMeta(prisma, 'account_summary')
    expect(meta.freshnessStatus).toBe('stale')
  })

  it('failed は経過時間で上書きしない', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary',
          lastSuccessAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-1',
          policyHash: 'hash-1',
          status: 'failed',
        },
      ],
    })

    const meta = await getReadModelMeta(prisma, 'account_summary')
    expect(meta.freshnessStatus).toBe('failed')
  })

  it('しきい値内なら healthy のまま返す', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-1',
          policyHash: 'hash-1',
          status: 'healthy',
        },
      ],
    })

    const meta = await getReadModelMeta(prisma, 'account_summary')
    expect(meta.freshnessStatus).toBe('healthy')
  })
})

describe('getPipelineMeta', () => {
  it('いずれかの read model が経過時間で劣化していれば全体も劣化させる', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-1',
          policyHash: 'hash-1',
          status: 'healthy',
        },
        {
          modelKey: 'label_summary',
          lastSuccessAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-2',
          policyHash: 'hash-1',
          status: 'healthy',
        },
      ],
    })

    const meta = await getPipelineMeta(prisma)
    expect(meta.freshnessStatus).toBe('stale')
  })

  it('全ての read model が healthy なら unknown ではなく healthy を返す', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-1',
          policyHash: 'hash-1',
          status: 'healthy',
        },
        {
          modelKey: 'label_summary',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-2',
          policyHash: 'hash-1',
          status: 'healthy',
        },
      ],
    })

    const meta = await getPipelineMeta(prisma)
    expect(meta.freshnessStatus).toBe('healthy')
  })
})

describe('overlayHealthWithFreshness', () => {
  it('freshness が stale なら operationalStatus/qualityStatus を critical/unknown にする', () => {
    expect(overlayHealthWithFreshness('healthy', 'stable', 'stale')).toEqual({
      operationalStatus: 'critical',
      qualityStatus: 'unknown',
    })
  })

  it('freshness が failed なら operationalStatus/qualityStatus を critical/unknown にする', () => {
    expect(overlayHealthWithFreshness('attention', 'watch', 'failed')).toEqual({
      operationalStatus: 'critical',
      qualityStatus: 'unknown',
    })
  })

  it('freshness が healthy/delayed なら元の値をそのまま返す', () => {
    expect(overlayHealthWithFreshness('attention', 'watch', 'healthy')).toEqual({
      operationalStatus: 'attention',
      qualityStatus: 'watch',
    })
    expect(overlayHealthWithFreshness('attention', 'watch', 'delayed')).toEqual({
      operationalStatus: 'attention',
      qualityStatus: 'watch',
    })
  })
})
