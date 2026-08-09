import { describe, it, expect, beforeEach } from 'vitest'
import {
  getCoreReadModelMeta,
  getPipelineMeta,
  getReadModelMeta,
  getReadModelReadiness,
  overlayHealthWithFreshness,
} from './read-model-meta'
import type { PrismaClient } from '../generated/prisma'
import { getPrismaClient } from './prisma'

/**
 * getReadModelMeta/getPipelineMeta/getCoreReadModelMeta が読む範囲だけを実装したモック。
 * @param overrides - readModelState/readModelPointer/detectionPolicyVersion の返り値
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
  blockRelationPointer?: unknown
}): PrismaClient {
  const states = overrides.readModelStates ?? []
  return {
    readModelState: {
      findUnique: (args: { where: { modelKey: string } }) =>
        Promise.resolve(states.find((state) => state.modelKey === args.where.modelKey) ?? null),
      findMany: (args?: { where?: { modelKey?: { in: string[] } } }) => {
        const keys = args?.where?.modelKey?.in
        return Promise.resolve(
          keys ? states.filter((state) => keys.includes(state.modelKey)) : states,
        )
      },
    },
    readModelPointer: {
      findUnique: () => Promise.resolve(overrides.blockRelationPointer ?? null),
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

describe('getCoreReadModelMeta', () => {
  it('block_relation の Pointer が存在しなければ対象から除外する', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary_latest',
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
        {
          modelKey: 'attention_items',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-3',
          policyHash: 'hash-1',
          status: 'healthy',
        },
        {
          modelKey: 'block_relation',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-4',
          policyHash: 'hash-1',
          status: 'failed',
        },
      ],
      blockRelationPointer: null,
    })

    const meta = await getCoreReadModelMeta(prisma)

    expect(meta.freshnessStatus).toBe('healthy')
    expect(meta.perModel.map((model) => model.modelKey)).not.toContain('block_relation')
  })

  it('block_relation の Pointer が存在すれば対象に含める', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary_latest',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-1',
          policyHash: 'hash-1',
          status: 'healthy',
        },
        {
          modelKey: 'block_relation',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-4',
          policyHash: 'hash-1',
          status: 'failed',
        },
      ],
      blockRelationPointer: { modelKey: 'block_relation', currentGenerationId: 'generation-4' },
    })

    const meta = await getCoreReadModelMeta(prisma)

    expect(meta.freshnessStatus).toBe('failed')
    expect(meta.perModel.map((model) => model.modelKey)).toContain('block_relation')
  })

  it('主要 read model のうち最も劣化した freshness を返す', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary_latest',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-1',
          policyHash: 'hash-1',
          status: 'delayed',
        },
        {
          modelKey: 'label_summary',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-2',
          policyHash: 'hash-1',
          status: 'stale',
        },
        {
          modelKey: 'attention_items',
          lastSuccessAt: new Date(),
          sourceWatermarkAt: new Date(),
          currentGenerationId: 'generation-3',
          policyHash: 'hash-1',
          status: 'healthy',
        },
      ],
    })

    const meta = await getCoreReadModelMeta(prisma)

    expect(meta.freshnessStatus).toBe('stale')
  })

  it('ReadModelState が 1 件も無ければ unknown な既定値を返す', async () => {
    const prisma = createMockPrisma({ readModelStates: [] })

    const meta = await getCoreReadModelMeta(prisma)

    expect(meta.freshnessStatus).toBe('unknown')
    expect(meta.perModel).toEqual([])
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

describe.skipIf(!process.env.DATABASE_URL)('getReadModelReadiness', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.readModelBootstrap.deleteMany()
    await prisma.readModelPointer.deleteMany({ where: { modelKey: 'label_summary' } })
    await prisma.readModelState.deleteMany({
      where: { modelKey: { in: ['label_summary', 'account_summary_latest'] } },
    })
    await prisma.readModelGeneration.deleteMany({ where: { modelKey: 'label_summary' } })
    // rowCount との一致判定は LabelDefinition 全件数を分母にするため、他ファイルのテストが
    // 残した LabelDefinition が残っていると誤って不一致になる。全件削除して分離する。
    await prisma.accountLabel.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.labelAggregate.deleteMany()
    await prisma.blockAction.deleteMany()
    await prisma.labelDefinition.deleteMany()
  })

  it('returns bootstrapping for both sections when ReadModelBootstrap is running', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'running' },
    })
    const readiness = await getReadModelReadiness(prisma)
    expect(readiness.accounts).toBe('bootstrapping')
    expect(readiness.labels).toBe('bootstrapping')
  })

  it('returns ready for labels only when the current generation covers every LabelDefinition', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'completed' },
    })
    await prisma.labelDefinition.createMany({
      data: [
        { key: 'label_1', description: 'l1' },
        { key: 'label_2', description: 'l2' },
      ],
    })
    const generation = await prisma.readModelGeneration.create({
      data: { modelKey: 'label_summary', schemaVersion: 1, status: 'current', rowCount: 1 },
    })
    await prisma.readModelPointer.create({
      data: { modelKey: 'label_summary', currentGenerationId: generation.id },
    })
    await prisma.readModelState.create({
      data: { modelKey: 'label_summary', schemaVersion: 1, status: 'healthy' },
    })
    await prisma.readModelState.create({
      data: { modelKey: 'account_summary_latest', schemaVersion: 1, status: 'healthy' },
    })

    const readiness = await getReadModelReadiness(prisma)
    expect(readiness.accounts).toBe('ready')
    expect(readiness.labels).toBe('bootstrapping')

    await prisma.readModelGeneration.update({ where: { id: generation.id }, data: { rowCount: 2 } })
    const readinessAfterFullGeneration = await getReadModelReadiness(prisma)
    expect(readinessAfterFullGeneration.labels).toBe('ready')
  })
})
