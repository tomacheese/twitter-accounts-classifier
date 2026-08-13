import type { ReadModelReadinessStatus } from './read-model-meta'

/** read model の鮮度。ReadModelState.status に対応する。 */
export type ReadModelFreshnessStatus = 'healthy' | 'delayed' | 'stale' | 'failed' | 'unknown'

/** source arrival・detector・read model projection の鮮度内訳。 */
export interface PipelineHealthBreakdown {
  overallStatus: ReadModelFreshnessStatus
  primaryCause: 'source' | 'detector' | 'projection' | null
  source: {
    status: ReadModelFreshnessStatus
    lastSourceWatermarkAt: Date | null
    lastOutcome: string | null
  }
  detector: {
    status: ReadModelFreshnessStatus
    processedWatermarkAt: Date | null
    lastFailureAt: Date | null
    errorSummary: string | null
  }
  projection: {
    status: ReadModelFreshnessStatus
    processedWatermarkAt: Date | null
  }
}

/** buildApiResponseMeta の入力。 */
export interface BuildApiResponseMetaInput {
  generatedAt: Date
  sourceDataAt: Date | null
  generationId: string | null
  policyHash: string | null
  freshnessStatus: ReadModelFreshnessStatus
  nextCursor?: string | null
  isPartial?: boolean
  partialReason?: string
  readiness?: ReadModelReadinessStatus
  pipelineHealth?: PipelineHealthBreakdown
}

/** 各 section の response が共通で含めるメタデータ。 */
export interface ApiResponseMeta {
  generatedAt: string
  sourceDataAt: string | null
  generationId: string | null
  policyHash: string | null
  freshnessStatus: ReadModelFreshnessStatus
  nextCursor: string | null
  isPartial: boolean
  partialReason?: string
  readiness?: ReadModelReadinessStatus
  pipelineHealth?: Omit<PipelineHealthBreakdown, 'source' | 'detector' | 'projection'> & {
    source: Omit<PipelineHealthBreakdown['source'], 'lastSourceWatermarkAt'> & {
      lastSourceWatermarkAt: string | null
    }
    detector: Omit<
      PipelineHealthBreakdown['detector'],
      'processedWatermarkAt' | 'lastFailureAt'
    > & {
      processedWatermarkAt: string | null
      lastFailureAt: string | null
    }
    projection: Omit<PipelineHealthBreakdown['projection'], 'processedWatermarkAt'> & {
      processedWatermarkAt: string | null
    }
  }
}

/**
 * 各 section の response が共通で含めるメタデータを組み立てる。
 * ReadModelState が stale・failed でも直近成功データ自体は消さず、
 * freshnessStatus だけを重ねて呼び出し元へ伝える構成を前提にする。
 * @param input - section ごとに集めたメタデータの元情報
 * @returns レスポンスへ含める共通メタデータ
 */
export function buildApiResponseMeta(input: BuildApiResponseMetaInput): ApiResponseMeta {
  return {
    generatedAt: input.generatedAt.toISOString(),
    sourceDataAt: input.sourceDataAt ? input.sourceDataAt.toISOString() : null,
    generationId: input.generationId,
    policyHash: input.policyHash,
    freshnessStatus: input.freshnessStatus,
    nextCursor: input.nextCursor ?? null,
    isPartial: input.isPartial ?? false,
    ...(input.partialReason ? { partialReason: input.partialReason } : {}),
    ...(input.readiness ? { readiness: input.readiness } : {}),
    ...(input.pipelineHealth
      ? {
          pipelineHealth: {
            ...input.pipelineHealth,
            source: {
              ...input.pipelineHealth.source,
              lastSourceWatermarkAt:
                input.pipelineHealth.source.lastSourceWatermarkAt?.toISOString() ?? null,
            },
            detector: {
              ...input.pipelineHealth.detector,
              processedWatermarkAt:
                input.pipelineHealth.detector.processedWatermarkAt?.toISOString() ?? null,
              lastFailureAt: input.pipelineHealth.detector.lastFailureAt?.toISOString() ?? null,
              // DB の例外文字列は System UI のみで redaction して表示する。公開 API では状態だけを返す。
              errorSummary: null,
            },
            projection: {
              ...input.pipelineHealth.projection,
              processedWatermarkAt:
                input.pipelineHealth.projection.processedWatermarkAt?.toISOString() ?? null,
            },
          },
        }
      : {}),
  }
}
