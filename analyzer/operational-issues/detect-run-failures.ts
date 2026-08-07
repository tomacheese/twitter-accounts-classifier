import type { PrismaClient } from '../generated/prisma'
import { computeFingerprint } from '../findings/fingerprint'

export interface DetectRunFailuresInput {
  component: string
  runId: string
  runStatus: string
  errorSummary: string | null
  now: Date
}

const FAILED_STATUSES = new Set(['failed', 'timeout'])

/**
 * Run 単位で一意な fingerprint (`run_failure` + component + runId) の
 * OperationalIssue を upsert する。同一 run を複数回処理しても
 * observationKey = runId で Occurrence が重複しない。
 * @param prisma - Prisma クライアント
 * @param input - 対象 run の状態
 */
export async function detectRunFailures(prisma: PrismaClient, input: DetectRunFailuresInput): Promise<void> {
  if (!FAILED_STATUSES.has(input.runStatus)) return

  const fingerprint = computeFingerprint('run_failure', { component: input.component, runId: input.runId })

  const issue = await prisma.operationalIssue.upsert({
    where: { fingerprint },
    create: {
      component: input.component,
      type: 'run_failure',
      fingerprint,
      status: 'active',
      severity: 'high',
      firstDetectedAt: input.now,
      lastDetectedAt: input.now,
    },
    update: {
      status: 'active',
      lastDetectedAt: input.now,
      resolvedAt: null,
    },
  })

  await prisma.operationalIssueOccurrence.upsert({
    where: { issueId_observationKey: { issueId: issue.id, observationKey: input.runId } },
    create: {
      issueId: issue.id,
      observedAt: input.now,
      stateTransition: 'activated',
      severity: 'high',
      sourceType: input.component,
      sourceId: input.runId,
      measurements: input.errorSummary ? { errorSummary: input.errorSummary } : {},
      observationKey: input.runId,
    },
    update: {},
  })
}
