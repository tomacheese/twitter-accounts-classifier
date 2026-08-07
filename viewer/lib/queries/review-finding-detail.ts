import type { PrismaClient } from '../../generated/prisma'

export interface ReviewFindingOccurrenceView {
  id: string
  observedAt: Date
  stateTransition: string
  severity: string
  observedValue: number | null
  baselineValue: number | null
  affectedCount: number | null
  totalCount: number | null
  affectedRatio: number | null
}

export interface ReviewFindingEvidenceView {
  id: string
  kind: string
  payload: unknown
  createdAt: Date
}

export interface ReviewFindingDetailView {
  id: string
  type: string
  status: string
  currentSeverity: string
  maximumSeverity: string
  primaryScopeType: string
  primaryScopeId: string
  firstDetectedAt: Date
  lastDetectedAt: Date
  resolvedAt: Date | null
  recurrenceCount: number
  occurrences: ReviewFindingOccurrenceView[]
  evidences: ReviewFindingEvidenceView[]
}

const RECENT_OCCURRENCE_LIMIT = 10

/**
 * spec の情報階層 (Conclusion→Impact→Detection Basis→Evidence→...) のうち、
 * 初期表示に必要な部分 (Conclusion〜Detection Basis、Occurrence 直近 10 件、
 * Evidence) だけを 1 クエリで取得する。Raw Analysis (FindingRawArtifact) は
 * 容量が大きく初期表示に不要なため、別関数 (getFindingRawArtifacts) で遅延取得する。
 * @param prisma - Prisma クライアント
 * @param findingId - 対象 ReviewFinding の ID
 * @returns Finding 詳細。存在しなければ null
 */
export async function getReviewFindingDetail(
  prisma: PrismaClient,
  findingId: string,
): Promise<ReviewFindingDetailView | null> {
  const finding = await prisma.reviewFinding.findUnique({
    where: { id: findingId },
    include: {
      occurrences: {
        orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
        take: RECENT_OCCURRENCE_LIMIT,
      },
      evidences: {
        orderBy: [{ createdAt: 'desc' }],
      },
    },
  })
  if (!finding) return null

  return {
    id: finding.id,
    type: finding.type,
    status: finding.status,
    currentSeverity: finding.currentSeverity,
    maximumSeverity: finding.maximumSeverity,
    primaryScopeType: finding.primaryScopeType,
    primaryScopeId: finding.primaryScopeId,
    firstDetectedAt: finding.firstDetectedAt,
    lastDetectedAt: finding.lastDetectedAt,
    resolvedAt: finding.resolvedAt,
    recurrenceCount: finding.recurrenceCount,
    occurrences: finding.occurrences.map((occurrence) => ({
      id: occurrence.id,
      observedAt: occurrence.observedAt,
      stateTransition: occurrence.stateTransition,
      severity: occurrence.severity,
      observedValue: occurrence.observedValue,
      baselineValue: occurrence.baselineValue,
      affectedCount: occurrence.affectedCount,
      totalCount: occurrence.totalCount,
      affectedRatio: occurrence.affectedRatio,
    })),
    evidences: finding.evidences.map((evidence) => ({
      id: evidence.id,
      kind: evidence.kind,
      payload: evidence.payload,
      createdAt: evidence.createdAt,
    })),
  }
}

/**
 * Raw Analysis (FindingRawArtifact) を遅延取得する。1 件 1 MiB を超える内容は
 * 書き込み時に切り詰め済み (isTruncated) のため、ここでは追加の truncate は行わない。
 * @param prisma - Prisma クライアント
 * @param findingId - 対象 ReviewFinding の ID
 * @returns Raw Analysis の一覧
 */
export async function getFindingRawArtifacts(
  prisma: PrismaClient,
  findingId: string,
): Promise<{ id: string; kind: string; content: string; isTruncated: boolean; createdAt: Date }[]> {
  return prisma.findingRawArtifact.findMany({
    where: { findingId },
    orderBy: [{ createdAt: 'desc' }],
  })
}
