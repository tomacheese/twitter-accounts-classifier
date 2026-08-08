import type { PrismaClient } from '../../generated/prisma'

/** OperationalIssue の観測 1 件。 */
export interface OperationalIssueOccurrenceView {
  id: string
  observedAt: Date
  stateTransition: string
  severity: string
  sourceType: string
  sourceId: string
}

/** OperationalIssue 詳細の表示内容。 */
export interface OperationalIssueDetailView {
  issueId: string
  component: string
  type: string
  status: string
  severity: string
  firstDetectedAt: Date
  lastDetectedAt: Date
  resolvedAt: Date | null
  sourceCycleId: string | null
  sourceCycleKind: string | null
  sourceStageId: string | null
  occurrences: OperationalIssueOccurrenceView[]
}

const OCCURRENCE_LIMIT = 50

/**
 * @param prisma - Prisma クライアント
 * @param issueId - 対象 OperationalIssue の ID
 * @returns OperationalIssue 詳細。存在しなければ null
 */
export async function getOperationalIssueDetail(
  prisma: PrismaClient,
  issueId: string,
): Promise<OperationalIssueDetailView | null> {
  const issue = await prisma.operationalIssue.findUnique({
    where: { id: issueId },
    include: {
      occurrences: {
        orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
        take: OCCURRENCE_LIMIT,
      },
    },
  })
  if (!issue) return null

  const sourceCycle = issue.sourceCycleId
    ? await prisma.operationCycle.findUnique({
        where: { id: issue.sourceCycleId },
        select: { kind: true },
      })
    : null

  return {
    issueId: issue.id,
    component: issue.component,
    type: issue.type,
    status: issue.status,
    severity: issue.severity,
    firstDetectedAt: issue.firstDetectedAt,
    lastDetectedAt: issue.lastDetectedAt,
    resolvedAt: issue.resolvedAt,
    sourceCycleId: issue.sourceCycleId,
    sourceCycleKind: sourceCycle?.kind ?? null,
    sourceStageId: issue.sourceStageId,
    occurrences: issue.occurrences.map((occurrence) => ({
      id: occurrence.id,
      observedAt: occurrence.observedAt,
      stateTransition: occurrence.stateTransition,
      severity: occurrence.severity,
      sourceType: occurrence.sourceType,
      sourceId: occurrence.sourceId,
    })),
  }
}
