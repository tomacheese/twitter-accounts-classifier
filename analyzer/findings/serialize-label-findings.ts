import { Logger } from '@book000/node-utils'
import type { Prisma, PrismaClient } from '../generated/prisma'

const logger = Logger.configure('analyzer:serialize-label-findings')

const DETECTOR_KEY = 'label_findings'

/**
 * runLabelFindingsSerialized の入力。
 */
export interface RunLabelFindingsSerializedInput {
  /** 今回処理する immutable evidence epoch。 */
  evidenceEpochId: string
  /** evidence が表す CrawlRun の terminal 時刻。 */
  sourceWatermarkAt: Date
  /** 評価に使用した policy の content hash。 */
  policyHash: string
  /** 評価を実行した Analyzer の version。 */
  analyzerVersion: string
  /** 直列化して実行する Finding 評価本体。 */
  run: (tx: Prisma.TransactionClient) => Promise<void>
}

/**
 * 複数の CrawlRun 起点 build が並行しても Finding 段の lifecycle 遷移が
 * evidence watermark の前後関係と食い違わないよう、DetectorState (detectorKey: 'label_findings')
 * の行ロックで直列化する。より新しい evidence watermark が既に処理済みなら、古い方は
 * lifecycle を巻き戻さないためスキップする。
 * @param prisma - Prisma クライアント
 * @param input - 対象 evidence の時刻と実行本体
 */
export async function runLabelFindingsSerialized(
  prisma: PrismaClient,
  input: RunLabelFindingsSerializedInput,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "DetectorState" ("detectorKey", "updatedAt")
        VALUES (${DETECTOR_KEY}, now())
        ON CONFLICT ("detectorKey") DO NOTHING
      `
      const rows = await tx.$queryRaw<{ sourceWatermarkAt: Date | null }[]>`
        SELECT "sourceWatermarkAt" FROM "DetectorState"
        WHERE "detectorKey" = ${DETECTOR_KEY}
        FOR UPDATE
      `
      const state = rows.at(0)
      if (state?.sourceWatermarkAt && input.sourceWatermarkAt <= state.sourceWatermarkAt) return

      await input.run(tx)

      await tx.detectorState.update({
        where: { detectorKey: DETECTOR_KEY },
        data: {
          lastEvidenceEpochId: input.evidenceEpochId,
          sourceWatermarkAt: input.sourceWatermarkAt,
          lastStartedAt: new Date(),
          lastSuccessAt: new Date(),
          policyHash: input.policyHash,
          analyzerVersion: input.analyzerVersion,
          errorCode: null,
          errorSummary: null,
        },
      })
    })
  } catch (error) {
    // input.run が投げた例外は上のトランザクション自体を rollback させるため、
    // 同じトランザクション内では failed を記録できない。別トランザクションで記録する。
    // 初回実行の失敗では INSERT ... ON CONFLICT DO NOTHING も rollback され行自体が
    // 存在しないため、update ではなく upsert で確実に failed を記録する。
    try {
      await prisma.detectorState.upsert({
        where: { detectorKey: DETECTOR_KEY },
        update: {
          lastStartedAt: new Date(),
          lastFailureAt: new Date(),
          errorCode: 'label_finding_generation_failed',
          errorSummary: String(error),
        },
        create: {
          detectorKey: DETECTOR_KEY,
          lastStartedAt: new Date(),
          lastFailureAt: new Date(),
          errorCode: 'label_finding_generation_failed',
          errorSummary: String(error),
        },
      })
    } catch (bookkeepingError) {
      logger.error(`failed to record label_findings failure`, bookkeepingError as Error)
    }
    throw error
  }
}
