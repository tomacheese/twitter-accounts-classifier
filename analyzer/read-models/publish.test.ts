import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import { publishGeneration } from './publish'

describe.skipIf(!process.env.DATABASE_URL)('publishGeneration', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.readModelPointer.deleteMany()
    await prisma.readModelState.deleteMany()
    await prisma.readModelGeneration.deleteMany()
  })

  it('build が成功すると Pointer が新 generation を指す', async () => {
    await publishGeneration(prisma, {
      modelKey: 'account_summary',
      schemaVersion: 1,
      sourceWatermarkAt: new Date(),
      build: () => Promise.resolve({ rowCount: 10 }),
    })

    const pointer = await prisma.readModelPointer.findUniqueOrThrow({
      where: { modelKey: 'account_summary' },
    })
    const generation = await prisma.readModelGeneration.findUniqueOrThrow({
      where: { id: pointer.currentGenerationId },
    })
    expect(generation.status).toBe('current')

    const state = await prisma.readModelState.findUniqueOrThrow({
      where: { modelKey: 'account_summary' },
    })
    expect(state.status).toBe('healthy')
  })

  it('ReadModelState に適用中 policy と analyzer 版数を残す', async () => {
    const policyVersion = `test-policy-${Date.now()}`
    // 他のテストが記録した policy より確実に新しくして、最新行の選択を一意にする。
    await prisma.detectionPolicyVersion.create({
      data: {
        policyVersion,
        contentHash: 'content-hash-for-test',
        schemaVersion: 1,
        content: {},
        loadedAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })

    try {
      await publishGeneration(prisma, {
        modelKey: 'label_summary',
        schemaVersion: 1,
        sourceWatermarkAt: new Date(),
        build: () => Promise.resolve({ rowCount: 1 }),
      })

      const state = await prisma.readModelState.findUniqueOrThrow({
        where: { modelKey: 'label_summary' },
      })
      expect(state.policyHash).toBe('content-hash-for-test')
      expect(state.analyzerVersion).not.toBeNull()
    } finally {
      await prisma.detectionPolicyVersion.delete({ where: { policyVersion } })
    }
  })

  it('build が失敗すると Pointer を進めず、旧 generation を current のまま維持する', async () => {
    await publishGeneration(prisma, {
      modelKey: 'account_summary',
      schemaVersion: 1,
      sourceWatermarkAt: new Date(),
      build: () => Promise.resolve({ rowCount: 10 }),
    })
    const before = await prisma.readModelPointer.findUniqueOrThrow({
      where: { modelKey: 'account_summary' },
    })

    await expect(
      publishGeneration(prisma, {
        modelKey: 'account_summary',
        schemaVersion: 1,
        sourceWatermarkAt: new Date(),
        build: () => Promise.reject(new Error('build failed')),
      }),
    ).rejects.toThrow('build failed')

    const after = await prisma.readModelPointer.findUniqueOrThrow({
      where: { modelKey: 'account_summary' },
    })
    expect(after.currentGenerationId).toBe(before.currentGenerationId)

    const state = await prisma.readModelState.findUniqueOrThrow({
      where: { modelKey: 'account_summary' },
    })
    expect(state.status).toBe('failed')
  })

  it('watermark が現在の generation 以前なら Pointer を進めない', async () => {
    const newer = new Date('2026-08-07T12:00:00.000Z')
    const older = new Date('2026-08-07T00:00:00.000Z')

    await publishGeneration(prisma, {
      modelKey: 'account_summary',
      schemaVersion: 1,
      sourceWatermarkAt: newer,
      build: () => Promise.resolve({ rowCount: 10 }),
    })
    const before = await prisma.readModelPointer.findUniqueOrThrow({
      where: { modelKey: 'account_summary' },
    })

    const staleGenerationId = await publishGeneration(prisma, {
      modelKey: 'account_summary',
      schemaVersion: 1,
      sourceWatermarkAt: older,
      build: () => Promise.resolve({ rowCount: 5 }),
    })

    const after = await prisma.readModelPointer.findUniqueOrThrow({
      where: { modelKey: 'account_summary' },
    })
    expect(after.currentGenerationId).toBe(before.currentGenerationId)

    const staleGeneration = await prisma.readModelGeneration.findUniqueOrThrow({
      where: { id: staleGenerationId },
    })
    expect(staleGeneration.status).toBe('retired')
  })

  it('watermark が異なる publish を並行実行しても、最終的に最新の watermark だけが current になる', async () => {
    const base = new Date('2026-08-08T00:00:00.000Z')
    const watermarks = [3, 1, 4, 0, 2].map((offset) => new Date(base.getTime() + offset * 1000))
    const newest = watermarks.toSorted((a, b) => b.getTime() - a.getTime())[0]

    // build の完了順を watermark の順序と無関係にするため、
    // 若い index ほど長く待たせて意図的に順序を混ぜる。
    const generationIds = await Promise.all(
      watermarks.map(async (watermark, index) => {
        await new Promise((resolve) => setTimeout(resolve, (watermarks.length - index) * 10))
        return publishGeneration(prisma, {
          modelKey: 'account_summary',
          schemaVersion: 1,
          sourceWatermarkAt: watermark,
          build: () => Promise.resolve({ rowCount: 1 }),
        })
      }),
    )

    const state = await prisma.readModelState.findUniqueOrThrow({
      where: { modelKey: 'account_summary' },
    })
    expect(state.sourceWatermarkAt).toEqual(newest)

    // 何を current とみなすかの正本は readModelPointer.currentGenerationId であるため、
    // 判定には generation.status ではなく pointer を使う。
    const pointer = await prisma.readModelPointer.findUniqueOrThrow({
      where: { modelKey: 'account_summary' },
    })
    const pointedGeneration = await prisma.readModelGeneration.findUniqueOrThrow({
      where: { id: pointer.currentGenerationId },
    })
    expect(pointedGeneration.sourceWatermarkAt).toEqual(newest)
    expect(generationIds).toContain(pointedGeneration.id)
  })

  it('新しい generation が current になると、旧 current だった generation を retired にする', async () => {
    const older = new Date('2026-08-08T00:00:00.000Z')
    const newer = new Date('2026-08-08T12:00:00.000Z')

    const firstGenerationId = await publishGeneration(prisma, {
      modelKey: 'account_summary',
      schemaVersion: 1,
      sourceWatermarkAt: older,
      build: () => Promise.resolve({ rowCount: 10 }),
    })

    await publishGeneration(prisma, {
      modelKey: 'account_summary',
      schemaVersion: 1,
      sourceWatermarkAt: newer,
      build: () => Promise.resolve({ rowCount: 10 }),
    })

    const firstGeneration = await prisma.readModelGeneration.findUniqueOrThrow({
      where: { id: firstGenerationId },
    })
    expect(firstGeneration.status).toBe('retired')
  })

  it('新しい run が publish した後に古い run が失敗しても、healthy な状態を failed で巻き戻さない', async () => {
    const newer = new Date('2026-08-08T12:00:00.000Z')
    const older = new Date('2026-08-08T00:00:00.000Z')

    await publishGeneration(prisma, {
      modelKey: 'account_summary',
      schemaVersion: 1,
      sourceWatermarkAt: newer,
      build: () => Promise.resolve({ rowCount: 10 }),
    })

    await expect(
      publishGeneration(prisma, {
        modelKey: 'account_summary',
        schemaVersion: 1,
        sourceWatermarkAt: older,
        build: () => Promise.reject(new Error('stale build failed')),
      }),
    ).rejects.toThrow('stale build failed')

    const state = await prisma.readModelState.findUniqueOrThrow({
      where: { modelKey: 'account_summary' },
    })
    expect(state.status).toBe('healthy')
    expect(state.sourceWatermarkAt).toEqual(newer)
  })

  it('公開のたびに不要となった世代の行と ReadModelGeneration を削除する', async () => {
    await prisma.attentionItemCurrent.deleteMany()

    const generationIds: string[] = []
    for (let index = 0; index < 4; index++) {
      const generationId = await publishGeneration(prisma, {
        modelKey: 'attention_items',
        schemaVersion: 1,
        // 単調性チェックが同一ミリ秒の new Date() 同士を「新しくない」と
        // 誤判定しないよう、各 iteration で明確に増加させる。
        sourceWatermarkAt: new Date(2026, 7, 7, 0, 0, index),
        build: async (id) => {
          await prisma.attentionItemCurrent.create({
            data: {
              generationId: id,
              sourceType: 'operational_issue',
              sourceId: `issue-${index}`,
              category: 'run_failure',
              priority: 1,
              severity: 'high',
              summary: 'test',
              impact: {},
              detectedAt: new Date(),
              freshness: 'current',
              detailHref: '/operations/issues/test',
            },
          })
          return { rowCount: 1 }
        },
      })
      generationIds.push(generationId)
    }

    const generations = await prisma.readModelGeneration.findMany({
      where: { modelKey: 'attention_items' },
    })
    expect(generations).toHaveLength(2)
    expect(generations.map((generation) => generation.id).toSorted()).toEqual(
      generationIds.slice(-2).toSorted(),
    )

    const rows = await prisma.attentionItemCurrent.findMany()
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => generationIds.slice(-2).includes(row.generationId))).toBe(true)
  })
})
