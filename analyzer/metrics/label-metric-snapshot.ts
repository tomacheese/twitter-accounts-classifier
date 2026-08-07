import type { PrismaClient } from '../generated/prisma'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:label-metric-snapshot')

/**
 * generateLabelMetricSnapshots の入力。
 */
export interface GenerateLabelMetricSnapshotsInput {
  /** 集計対象の CrawlRun ID。 */
  crawlRunId: string
  /** 集計の基準時刻。 */
  sourceWatermarkAt: Date
  /** 適用したポリシーの content hash。 */
  policyHash: string
  /** 集計を行った analyzer のバージョン。 */
  analyzerVersion: string
  /** 紐づく AnalysisRun の ID。 */
  analysisRunId?: string
}

/**
 * @param prisma - Prisma クライアント
 * @param labelDefinitionId - 集計対象の LabelDefinition
 * @param input - 対象 crawl run と付随メタデータ
 */
async function generateOneLabelSnapshot(
  prisma: PrismaClient,
  labelDefinitionId: string,
  input: GenerateLabelMetricSnapshotsInput,
): Promise<void> {
  const [aggregate, trueAggregate] = await Promise.all([
    prisma.accountLabelLatest.aggregate({ where: { labelDefinitionId }, _count: { _all: true } }),
    prisma.accountLabelLatest.aggregate({
      where: { labelDefinitionId, value: true },
      _count: { _all: true },
      _avg: { confidence: true },
    }),
  ])
  const evaluatedCount = aggregate._count._all
  const trueCount = trueAggregate._count._all
  const prevalence = evaluatedCount === 0 ? 0 : trueCount / evaluatedCount

  await prisma.labelMetricSnapshot.upsert({
    where: {
      sourceCrawlRunId_labelDefinitionId: { sourceCrawlRunId: input.crawlRunId, labelDefinitionId },
    },
    create: {
      sourceCrawlRunId: input.crawlRunId,
      labelDefinitionId,
      observedAt: input.sourceWatermarkAt,
      sourceWatermarkAt: input.sourceWatermarkAt,
      evaluatedCount,
      trueCount,
      prevalence,
      trueConfidenceAverage: trueAggregate._avg.confidence ?? undefined,
      completeness: 'complete',
      policyHash: input.policyHash,
      analyzerVersion: input.analyzerVersion,
      analysisRunId: input.analysisRunId,
    },
    update: {
      evaluatedCount,
      trueCount,
      prevalence,
      trueConfidenceAverage: trueAggregate._avg.confidence ?? undefined,
      completeness: 'complete',
    },
  })
}

/**
 * LabelDefinition ごとに独立して集計・checkpoint する。
 * 1 Label の失敗が他 Label の結果を巻き込まないよう、Promise.allSettled で並行実行する。
 * 失敗した Label は completeness: 'unknown' の行として記録する。
 * 行自体を欠落させると「集計されていない」のか「値が 0 件」なのか区別できなくなるため。
 * @param prisma - Prisma クライアント
 * @param input - 対象 crawl run と付随メタデータ
 */
export async function generateLabelMetricSnapshots(
  prisma: PrismaClient,
  input: GenerateLabelMetricSnapshotsInput,
): Promise<void> {
  const labelDefinitions = await prisma.labelDefinition.findMany({ select: { id: true } })

  const results = await Promise.allSettled(
    labelDefinitions.map((label) => generateOneLabelSnapshot(prisma, label.id, input)),
  )

  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      const labelDefinitionId = labelDefinitions[index]?.id
      if (!labelDefinitionId) continue
      logger.error(
        `label metric snapshot failed for label ${labelDefinitionId}`,
        result.reason as Error,
      )
      await prisma.labelMetricSnapshot.upsert({
        where: {
          sourceCrawlRunId_labelDefinitionId: {
            sourceCrawlRunId: input.crawlRunId,
            labelDefinitionId,
          },
        },
        create: {
          sourceCrawlRunId: input.crawlRunId,
          labelDefinitionId,
          observedAt: input.sourceWatermarkAt,
          sourceWatermarkAt: input.sourceWatermarkAt,
          evaluatedCount: 0,
          trueCount: 0,
          prevalence: 0,
          completeness: 'unknown',
          policyHash: input.policyHash,
          analyzerVersion: input.analyzerVersion,
          analysisRunId: input.analysisRunId,
        },
        update: { completeness: 'unknown' },
      })
    }
  }
}
