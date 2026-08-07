import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import { publishGeneration } from './publish'

describe('publishGeneration', () => {
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
})
