import type { Prisma, PrismaClient } from '../generated/prisma'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:read-models:publish')

// 直前世代を 1 つ残す。
// Pointer 切り替え直前に旧世代を読み始めた viewer のクエリが、
// 読み取り途中で行を消されないようにするため。
const RETAINED_GENERATIONS = 2

/**
 * generationId で世代管理されている読み取りモデルの行削除処理。
 * OverviewSnapshot は generationId を持たないため、この表ではなく generatedAt で刈り込む。
 */
const GENERATION_ROW_DELETERS: Record<
  string,
  ((prisma: PrismaClient, generationIds: string[]) => Promise<unknown>) | undefined
> = {
  account_summary: (prisma, generationIds) =>
    prisma.accountSummaryCurrent.deleteMany({ where: { generationId: { in: generationIds } } }),
  label_summary: (prisma, generationIds) =>
    prisma.labelSummaryCurrent.deleteMany({ where: { generationId: { in: generationIds } } }),
  attention_items: (prisma, generationIds) =>
    prisma.attentionItemCurrent.deleteMany({ where: { generationId: { in: generationIds } } }),
  block_relation: (prisma, generationIds) =>
    prisma.blockRelationCurrent.deleteMany({ where: { generationId: { in: generationIds } } }),
}

/**
 * OverviewSnapshot は generationId を持たないため、新しい順に RETAINED_GENERATIONS 件だけ残す。
 * @param prisma - Prisma クライアント
 */
async function pruneOverviewSnapshots(prisma: PrismaClient): Promise<void> {
  const obsolete = await prisma.overviewSnapshot.findMany({
    orderBy: [{ generatedAt: 'desc' }],
    skip: RETAINED_GENERATIONS,
    select: { id: true },
  })
  if (obsolete.length === 0) return

  await prisma.overviewSnapshot.deleteMany({
    where: { id: { in: obsolete.map((snapshot) => snapshot.id) } },
  })
}

/**
 * Pointer 切り替え後に不要となった世代の行と ReadModelGeneration を削除する。
 * 削除に失敗しても公開自体は成立しているため、例外は呼び出し元へ伝播させない。
 * @param prisma - Prisma クライアント
 * @param modelKey - 対象の読み取りモデル
 * @param currentGenerationId - 現在 Pointer が指している generationId
 */
async function pruneSupersededGenerations(
  prisma: PrismaClient,
  modelKey: string,
  currentGenerationId: string,
): Promise<void> {
  if (modelKey === 'overview_snapshot') await pruneOverviewSnapshots(prisma)

  const obsolete = await prisma.readModelGeneration.findMany({
    where: { modelKey, id: { not: currentGenerationId } },
    orderBy: [{ startedAt: 'desc' }],
    skip: RETAINED_GENERATIONS - 1,
    select: { id: true },
  })
  if (obsolete.length === 0) return

  const generationIds = obsolete.map((generation) => generation.id)
  await GENERATION_ROW_DELETERS[modelKey]?.(prisma, generationIds)
  await prisma.readModelGeneration.deleteMany({ where: { id: { in: generationIds } } })
}

/**
 * publishGeneration の入力。
 */
export interface PublishGenerationInput {
  /** 対象の読み取りモデル。 */
  modelKey: string
  /** 読み取りモデルのスキーマ版数。 */
  schemaVersion: number
  /** 集計の基準時刻。 */
  sourceWatermarkAt: Date
  /** 紐づく AnalysisRun の ID。 */
  analysisRunId?: string
  /** 新しい generationId 宛てに行を書き込む処理。 */
  build: (
    generationId: string,
  ) => Promise<{ rowCount: number; validationSummary?: Record<string, unknown> }>
}

/**
 * 新 generation へ書き込んでから検証し、成功した場合だけ Pointer を切り替える。
 * build が例外を投げた場合は generation を failed にして Pointer を変更しない。
 * これにより build 中の generation へ Pointer を切り替えず、
 * 部分成功した集合を current として公開しないことを保証する。
 * Pointer 切り替え後は不要になった世代を削除し、公開のたびに行が積み上がるのを防ぐ。
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

    try {
      await pruneSupersededGenerations(prisma, input.modelKey, generation.id)
    } catch (error) {
      logger.error(`failed to prune superseded generations for ${input.modelKey}`, error as Error)
    }

    return generation.id
  } catch (error) {
    // 失敗記録の書き込みが更に失敗しても、呼び出し元へは本来の原因を伝える。
    try {
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
    } catch (bookkeepingError) {
      logger.error(
        `failed to record publish failure for ${input.modelKey}`,
        bookkeepingError as Error,
      )
    }
    throw error
  }
}
