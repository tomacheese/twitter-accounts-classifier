import type { Prisma, PrismaClient } from '../generated/prisma'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:read-models:publish')

// 直前世代を 1 つ残す。
// Pointer 切り替え直前に旧世代を読み始めた viewer のクエリが、
// 読み取り途中で行を消されないようにするため。
const RETAINED_GENERATIONS = 2

const ANALYZER_VERSION = process.env.APPLICATION_VERSION ?? 'unknown'

/**
 * modelKey 単位で ReadModelState の行ロックを取り、行が無ければ先に作る。
 * `SELECT ... FOR UPDATE` により、同一 modelKey への並行する publish 判定を
 * transaction の commit まで直列化する。これが無いと、複数 worker が同時に
 * 同じ旧 watermark を読んで両方 `isNewer=true` と判定し、後から commit した方の
 * 古い watermark が新しい方を pointer 上で巻き戻せてしまう。
 * @param tx - transaction 内の Prisma クライアント
 * @param modelKey - 対象の読み取りモデル
 * @param schemaVersion - 行が無い場合の初期値
 * @returns ロック取得時点の sourceWatermarkAt。行が無かった場合は null
 */
async function lockReadModelStateRow(
  tx: Prisma.TransactionClient,
  modelKey: string,
  schemaVersion: number,
): Promise<Date | null> {
  await tx.$executeRaw`
    INSERT INTO "ReadModelState" ("modelKey", "schemaVersion", "status")
    VALUES (${modelKey}, ${schemaVersion}, 'unknown')
    ON CONFLICT ("modelKey") DO NOTHING
  `
  const rows = await tx.$queryRaw<{ sourceWatermarkAt: Date | null }[]>`
    SELECT "sourceWatermarkAt" FROM "ReadModelState" WHERE "modelKey" = ${modelKey} FOR UPDATE
  `
  return rows[0]?.sourceWatermarkAt ?? null
}

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
 * `overview_snapshot` は他モデルと異なり trend 表示用に日数単位で保持するため、
 * ここでは扱わず `runRetentionSweep` の日数ベース retention に任せる。
 */
const GENERATION_ROW_DELETERS: Record<
  string,
  ((prisma: PrismaClient, generationIds: string[]) => Promise<unknown>) | undefined
> = {
  label_summary: (prisma, generationIds) =>
    prisma.labelSummaryCurrent.deleteMany({ where: { generationId: { in: generationIds } } }),
  attention_items: (prisma, generationIds) =>
    prisma.attentionItemCurrent.deleteMany({ where: { generationId: { in: generationIds } } }),
  block_relation: (prisma, generationIds) =>
    prisma.blockRelationCurrent.deleteMany({ where: { generationId: { in: generationIds } } }),
}

/**
 * Pointer 切り替え後に不要となった世代の行と ReadModelGeneration を削除する。
 * 削除に失敗しても公開自体は成立しているため、例外は呼び出し元へ伝播させない。
 * 呼び出し元 (publishGeneration) が自分の generationId を渡すのではなく、
 * ここで Pointer を読み直す。並行 publish では自分の transaction が commit した後、
 * 別の publish が先に更に新しい generation へ Pointer を切り替えている場合があり、
 * 古い generationId を保護対象として渡すと、その後の current generation を
 * 誤って削除してしまう。
 * @param prisma - Prisma クライアント
 * @param modelKey - 対象の読み取りモデル
 */
async function pruneSupersededGenerations(prisma: PrismaClient, modelKey: string): Promise<void> {
  const pointer = await prisma.readModelPointer.findUnique({
    where: { modelKey },
    select: { currentGenerationId: true },
  })
  if (!pointer) return

  const obsolete = await prisma.readModelGeneration.findMany({
    // 同一 modelKey への並行 publish が居ると、まだ build 中の generation も
    // startedAt の並びに混ざる。terminal 状態でない行を削除すると、
    // その publish 自身の後続 update が対象行を失って失敗するため対象から外す。
    where: { modelKey, id: { not: pointer.currentGenerationId }, status: { not: 'building' } },
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
    // 古い run の publish より先に終わりうる。watermark の単調性判定を
    // lockReadModelStateRow の行ロックで直列化しないと、後から完了した古い run が
    // current pointer を巻き戻してしまう。
    const isNewerThanCurrent = await prisma.$transaction(async (tx) => {
      const currentWatermark = await lockReadModelStateRow(tx, input.modelKey, input.schemaVersion)
      const isNewer = !currentWatermark || input.sourceWatermarkAt > currentWatermark

      await tx.readModelGeneration.update({
        where: { id: generation.id },
        data: {
          // 設計上の generation status は building/current/retired/failed の 4 値であり、
          // superseded という独自状態は持たない。watermark 判定で current に採用されず
          // 終わった build も、current だった世代が入れ替わる場合と同じ「もう current
          // ではない完了済み世代」であるため、既存語彙の retired へ揃える。
          status: isNewer ? 'current' : 'retired',
          completedAt: new Date(),
          rowCount: result.rowCount,
          validationSummary: (result.validationSummary ?? {}) as Prisma.InputJsonValue,
        },
      })

      if (!isNewer) return false

      const previousPointer = await tx.readModelPointer.findUnique({
        where: { modelKey: input.modelKey },
        select: { currentGenerationId: true },
      })

      await tx.readModelPointer.upsert({
        where: { modelKey: input.modelKey },
        create: { modelKey: input.modelKey, currentGenerationId: generation.id },
        update: { currentGenerationId: generation.id, switchedAt: new Date() },
      })

      // Pointer の切り替え前まで current だった世代は、削除されるまで
      // status が current のまま残ると System/diagnostics で複数 current が
      // 見えてしまう。切り替えと同じ transaction 内で retired にする。
      if (previousPointer && previousPointer.currentGenerationId !== generation.id) {
        await tx.readModelGeneration.updateMany({
          where: { id: previousPointer.currentGenerationId, status: 'current' },
          data: { status: 'retired' },
        })
      }
      await tx.readModelState.update({
        where: { modelKey: input.modelKey },
        data: {
          schemaVersion: input.schemaVersion,
          status: 'healthy',
          currentGenerationId: generation.id,
          sourceWatermarkAt: input.sourceWatermarkAt,
          lastStartedAt: generation.startedAt,
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
        await pruneSupersededGenerations(prisma, input.modelKey)
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
      // この build がより新しい run の publish より遅れて失敗した場合、
      // ReadModelState は既にその新しい run の watermark で healthy になっている。
      // ここで無条件に failed を書くと、その新しい current model を巻き戻してしまう。
      await prisma.$transaction(async (tx) => {
        const currentWatermark = await lockReadModelStateRow(
          tx,
          input.modelKey,
          input.schemaVersion,
        )
        const supersededByNewerRun =
          currentWatermark !== null && currentWatermark >= input.sourceWatermarkAt
        if (supersededByNewerRun) return

        await tx.readModelState.update({
          where: { modelKey: input.modelKey },
          data: { status: 'failed', lastFailureAt: new Date(), errorSummary: String(error) },
        })
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
