export type ReadModelFreshnessStatus = 'healthy' | 'stale' | 'failed' | 'unknown'

export interface BuildApiResponseMetaInput {
  generatedAt: Date
  sourceDataAt: Date | null
  generationId: string | null
  policyHash: string | null
  freshnessStatus: ReadModelFreshnessStatus
  nextCursor?: string | null
  isPartial?: boolean
  partialReason?: string
}

export interface ApiResponseMeta {
  generatedAt: string
  sourceDataAt: string | null
  generationId: string | null
  policyHash: string | null
  freshnessStatus: ReadModelFreshnessStatus
  nextCursor: string | null
  isPartial: boolean
  partialReason?: string
}

/**
 * spec が定める「各 section response が含める共通メタデータ」を組み立てる。
 * ReadModelState が stale/failed でも直近成功データ自体は消さず、
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
  }
}
