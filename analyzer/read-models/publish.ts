import type { Prisma, PrismaClient } from '../generated/prisma'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:read-models:publish')

// 直前世代を 1 つ残す。
// Pointer 切り替え直前に旧世代を読み始めた viewer のクエリが、
// 読み取り途中で行を消されないようにするため。
const RETAINED_GENERATIONS = 2

const ANALYZER_VERSION = process.env.APPLICATION_VERSION ?? 'unknown'

/**
 * 公開時点で適用されている policy の content hash を得る。
 * 呼び出し元ごとに policy を読み直すと、公開の途中で入れ替わった場合に
 * ReadModelState が実際の生成条件と食い違うため、記録済みの値を参照する。
 * @param prisma - Prisma クライアント
 * @returns 最新の DetectionPolicyVersion の content hash。未記録なら null
 */
async function getActivePolicyHash(prisma: PrismaClient): Promise<string | null> {
  const latest = await prisma.detectionPolicyVersion.findFirst({
    orderBy: [{ loadedAt: 'desc' }],
    select: { contentHash: true },
  })
  return latest?.contentHash ?? null
}

/**
 * generationId で世代管理されている読み取りモデルの行削除処理。
 */
const GENERATION_ROW_DELETERS: Record<
  string,
  ((prisma: PrismaClient, generationIds: string[]) => Promise<unknown>) | undefined
> = {
  account_summary: async (prisma, generationIds) => {
    await prisma.accountClassificationCurrent.deleteMany({
      where: { generationId: { in: generationIds } },
    })
    await prisma.accountSummaryCurrent.deleteMany({
      where: { generationId: { in: generationIds } },
    })
  },
  label_summary: (prisma, generationIds) =>
    prisma.labelSummaryCurrent.deleteMany({ where: { generationId: { in: generationIds } } }),
  attention_items: (prisma, generationIds) =>
    prisma.attentionItemCurrent.deleteMany({ where: { generationId: { in: generationIds } } }),
  block_relation: (prisma, generationIds) =>
    prisma.blockRelationCurrent.deleteMany({ where: { generationId: { in: generationIds } } }),
  overview_snapshot: (prisma, generationIds) =>
    prisma.overviewSnapshot.deleteMany({ where: { generationId: { in: generationIds } } }),
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
    const policyHash = await getActivePolicyHash(prisma)

    // ANALYZER_WORKER_CONCURRENCY > 1 やバックログ処理では、新しい run の publish が
    // 古い run の publish より先に終わりうる。watermark の単調性を transaction 内で
    // 判定しないと、後から完了した古い run が current pointer を巻き戻してしまう。
    const isNewerThanCurrent = await prisma.$transaction(async (tx) => {
      const currentState = await tx.readModelState.findUnique({
        where: { modelKey: input.modelKey },
      })
      const isNewer =
        !currentState?.sourceWatermarkAt || input.sourceWatermarkAt > currentState.sourceWatermarkAt

      await tx.readModelGeneration.update({
        where: { id: generation.id },
        data: {
          status: isNewer ? 'current' : 'superseded',
          completedAt: new Date(),
          rowCount: result.rowCount,
          validationSummary: (result.validationSummary ?? {}) as Prisma.InputJsonValue,
        },
      })

      if (!isNewer) return false

      await tx.readModelPointer.upsert({
        where: { modelKey: input.modelKey },
        create: { modelKey: input.modelKey, currentGenerationId: generation.id },
        update: { currentGenerationId: generation.id, switchedAt: new Date() },
      })
      await tx.readModelState.upsert({
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
          policyHash,
          analyzerVersion: ANALYZER_VERSION,
        },
        update: {
          status: 'healthy',
          currentGenerationId: generation.id,
          sourceWatermarkAt: input.sourceWatermarkAt,
          lastSuccessAt: new Date(),
          rowCount: result.rowCount,
          policyHash,
          analyzerVersion: ANALYZER_VERSION,
          errorCode: null,
          errorSummary: null,
        },
      })
      return true
    })

    if (isNewerThanCurrent) {
      try {
        await pruneSupersededGenerations(prisma, input.modelKey, generation.id)
      } catch (error) {
        logger.error(`failed to prune superseded generations for ${input.modelKey}`, error as Error)
      }
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
