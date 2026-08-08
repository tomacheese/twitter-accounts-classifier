import type { Prisma, PrismaClient } from '../generated/prisma'

const ATTENTION_PAYLOAD_LIMIT = 8

/** Operational Health の総合状態。 */
export type OperationalStatus = 'healthy' | 'attention' | 'critical' | 'unknown'
/** Classification Quality の総合状態。 */
export type QualityStatus = 'stable' | 'watch' | 'degraded' | 'unknown'

/**
 * deriveOperationalStatus の入力。
 */
export interface DeriveOperationalStatusInput {
  /** severity が critical の OperationalIssue があるか。 */
  hasCriticalIssue: boolean
  /** 必須 Stage に failed/stale があるか。 */
  hasFailedOrStaleCoreStage: boolean
  /** 必須 Stage に unknown があるか。 */
  hasUnknownCoreStage: boolean
  /** active な OperationalIssue があるか。 */
  hasActiveIssue: boolean
}

/**
 * critical → unknown → attention → healthy の優先順位で総合状態を決める。
 * Crawl が succeeded でも必須後続 Stage が failed/stale なら
 * パイプライン全体としては信頼できないため critical 判定へ含める。
 * @param input - 判定に必要な各種フラグ
 * @returns Operational Health の総合状態
 */
export function deriveOperationalStatus(input: DeriveOperationalStatusInput): OperationalStatus {
  if (input.hasCriticalIssue || input.hasFailedOrStaleCoreStage) return 'critical'
  if (input.hasUnknownCoreStage) return 'unknown'
  if (input.hasActiveIssue) return 'attention'
  return 'healthy'
}

/**
 * deriveQualityStatus の入力。
 */
export interface DeriveQualityStatusInput {
  /** 評価データ自体が unknown か。 */
  isDataUnknown: boolean
  /** critical/high の ReviewFinding があるか。 */
  hasDegradingFinding: boolean
  /** medium の ReviewFinding があるか。 */
  hasWatchFinding: boolean
}

/**
 * 評価データ自体が unknown の場合、過去の状態を引き継がず現在状態を unknown にする。
 * 古い評価結果を現在の品質として提示すると、
 * 未評価の状態を「問題なし」と誤読させるため。
 * @param input - 判定に必要な各種フラグ
 * @returns Classification Quality の総合状態
 */
export function deriveQualityStatus(input: DeriveQualityStatusInput): QualityStatus {
  if (input.isDataUnknown) return 'unknown'
  if (input.hasDegradingFinding) return 'degraded'
  if (input.hasWatchFinding) return 'watch'
  return 'stable'
}

/**
 * buildOverviewSnapshot の入力。
 */
export interface BuildOverviewSnapshotInput {
  /** publishGeneration が発行した ReadModelGeneration.id。 */
  generationId: string
  /** 集計の基準時刻。 */
  sourceWatermarkAt: Date
  /** 紐づく AnalysisRun の ID。 */
  analysisRunId?: string
}

/**
 * OperationalIssue・OperationCycle・ReviewFinding・ReadModelState を集約し、
 * 総合判定と bounded payload を OverviewSnapshot へ書く。
 * 巨大な正本テーブルを直接返さず、
 * ATTENTION_PAYLOAD_LIMIT 件までの Attention など上限付きの情報だけを payload に含める。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generation の検索基準時刻
 * @returns 作成した OverviewSnapshot の ID
 */
export async function buildOverviewSnapshot(
  prisma: PrismaClient,
  input: BuildOverviewSnapshotInput,
): Promise<{ id: string }> {
  const [
    activeIssues,
    latestCycle,
    criticalFindingCount,
    watchFindingCount,
    readModelStates,
    attentionPointer,
  ] = await Promise.all([
    prisma.operationalIssue.findMany({ where: { status: 'active' } }),
    prisma.operationCycle.findFirst({
      where: { sourceType: 'crawl_run' },
      orderBy: [{ triggeredAt: 'desc' }],
      include: { stages: true },
    }),
    prisma.reviewFinding.count({
      where: {
        status: { in: ['active', 'recurring'] },
        currentSeverity: { in: ['critical', 'high'] },
      },
    }),
    prisma.reviewFinding.count({
      where: { status: { in: ['active', 'recurring'] }, currentSeverity: 'medium' },
    }),
    prisma.readModelState.findMany(),
    prisma.readModelPointer.findUnique({ where: { modelKey: 'attention_items' } }),
  ])

  const coreStageKeys = new Set([
    'crawl',
    'label_metrics',
    'finding_generation',
    'read_model_refresh',
  ])
  const coreStages = (latestCycle?.stages ?? []).filter((stage) =>
    coreStageKeys.has(stage.stageKey),
  )

  const operationalStatus = deriveOperationalStatus({
    hasCriticalIssue: activeIssues.some((issue) => issue.severity === 'critical'),
    hasFailedOrStaleCoreStage: coreStages.some(
      (stage) => stage.status === 'failed' || stage.status === 'stale',
    ),
    hasUnknownCoreStage: coreStages.some((stage) => stage.status === 'unknown'),
    hasActiveIssue: activeIssues.length > 0,
  })

  const qualityStatus = deriveQualityStatus({
    isDataUnknown: readModelStates.some(
      (state) =>
        state.modelKey === 'label_summary' &&
        (state.status === 'failed' || state.status === 'unknown'),
    ),
    hasDegradingFinding: criticalFindingCount > 0,
    hasWatchFinding: watchFindingCount > 0,
  })

  const attentionItems = attentionPointer
    ? await prisma.attentionItemCurrent.findMany({
        where: { generationId: attentionPointer.currentGenerationId },
        orderBy: [{ priority: 'asc' }],
        take: ATTENTION_PAYLOAD_LIMIT,
      })
    : []

  const snapshot = await prisma.overviewSnapshot.create({
    data: {
      generationId: input.generationId,
      schemaVersion: 1,
      sourceWatermarkAt: input.sourceWatermarkAt,
      operationalStatus,
      qualityStatus,
      analysisRunId: input.analysisRunId,
      payload: {
        attention: attentionItems.map((item) => ({
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          category: item.category,
          severity: item.severity,
          summary: item.summary,
          detailHref: item.detailHref,
        })),
        latestPipeline: latestCycle
          ? {
              cycleId: latestCycle.id,
              status: latestCycle.status,
              stages: latestCycle.stages.map((stage) => ({
                stageKey: stage.stageKey,
                status: stage.status,
              })),
            }
          : null,
      } as Prisma.InputJsonValue,
    },
  })

  return { id: snapshot.id }
}
