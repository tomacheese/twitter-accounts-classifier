import type { PrismaClient } from '../generated/prisma'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:label-metric-snapshot')

export interface GenerateLabelMetricSnapshotsInput {
  crawlRunId: string
  sourceWatermarkAt: Date
  policyHash: string
  analyzerVersion: string
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
 * 1 Label の失敗が他 Label の結果を巻き込まないよう、Promise.allSettled で
 * 並行実行し、失敗した Label は completeness: 'unknown' の行として記録する
 * (行自体を欠落させると「集計されていない」のか「値が0件」なのか区別できなくなるため)。
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
