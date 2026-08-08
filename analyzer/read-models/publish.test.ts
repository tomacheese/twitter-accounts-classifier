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
    expect(staleGeneration.status).toBe('superseded')
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
