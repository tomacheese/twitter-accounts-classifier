import type { Prisma, PrismaClient } from '../generated/prisma'

export interface PublishGenerationInput {
  modelKey: string
  schemaVersion: number
  sourceWatermarkAt: Date
  analysisRunId?: string
  build: (
    generationId: string,
  ) => Promise<{ rowCount: number; validationSummary?: Record<string, unknown> }>
}

/**
 * 新 generation へ書き込んでから検証し、成功した場合だけ Pointer を切り替える。
 * build が例外を投げた場合は generation を failed にして Pointer を変更しない。
 * これにより build 中の generation へ Pointer を切り替えず、
 * 部分成功した集合を current として公開しないことを保証する。
 * @param prisma - Prisma クライアント
 * @param input - 対象モデルと build コールバック
 * @returns 新しく作られた generation の ID
 */
export async function publishGeneration(
  prisma: PrismaClient,
  input: PublishGenerationInput,
): Promise<string> {
  const generation = await prisma.readModelGeneration.create({
    data: {
      modelKey: input.modelKey,
      schemaVersion: input.schemaVersion,
      status: 'building',
      sourceWatermarkAt: input.sourceWatermarkAt,
      analysisRunId: input.analysisRunId,
    },
  })

  try {
    const result = await input.build(generation.id)

    await prisma.$transaction([
      prisma.readModelGeneration.update({
        where: { id: generation.id },
        data: {
          status: 'current',
          completedAt: new Date(),
          rowCount: result.rowCount,
          validationSummary: (result.validationSummary ?? {}) as Prisma.InputJsonValue,
        },
      }),
      prisma.readModelPointer.upsert({
        where: { modelKey: input.modelKey },
        create: { modelKey: input.modelKey, currentGenerationId: generation.id },
        update: { currentGenerationId: generation.id, switchedAt: new Date() },
      }),
      prisma.readModelState.upsert({
        where: { modelKey: input.modelKey },
        create: {
          modelKey: input.modelKey,
          schemaVersion: input.schemaVersion,
          status: 'healthy',
          currentGenerationId: generation.id,
          sourceWatermarkAt: input.sourceWatermarkAt,
          lastStartedAt: generation.startedAt,
          lastSuccessAt: new Date(),
          rowCount: result.rowCount,
        },
        update: {
          status: 'healthy',
          currentGenerationId: generation.id,
          sourceWatermarkAt: input.sourceWatermarkAt,
          lastSuccessAt: new Date(),
          rowCount: result.rowCount,
          errorCode: null,
          errorSummary: null,
        },
      }),
    ])

    return generation.id
  } catch (error) {
    await prisma.readModelGeneration.update({
      where: { id: generation.id },
      data: { status: 'failed' },
    })
    await prisma.readModelState.upsert({
      where: { modelKey: input.modelKey },
      create: {
        modelKey: input.modelKey,
        schemaVersion: input.schemaVersion,
        status: 'failed',
        lastStartedAt: generation.startedAt,
        lastFailureAt: new Date(),
        errorSummary: String(error),
      },
      update: { status: 'failed', lastFailureAt: new Date(), errorSummary: String(error) },
    })
    throw error
  }
}
