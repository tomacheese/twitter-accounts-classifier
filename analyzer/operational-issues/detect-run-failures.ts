import type { PrismaClient } from '../generated/prisma'
import { computeFingerprint } from '../findings/fingerprint'

/**
 * detectRunFailures の入力。
 */
export interface DetectRunFailuresInput {
  /** 対象コンポーネント (crawl、block など)。 */
  component: string
  /** 対象 Run の ID。 */
  runId: string
  /** 対象 Run の終了状態。 */
  runStatus: string
  /** 記録するエラー概要。 */
  errorSummary: string | null
  /** 判定の基準時刻。 */
  now: Date
  /** 記録する severity。既定は high。 */
  severity?: string
  /** Occurrence の重複判定キー。既定は runId。 */
  observationKey?: string
}

const FAILED_STATUSES = new Set(['failed', 'timeout', 'dead'])

/**
 * Run 単位で一意な fingerprint の OperationalIssue を upsert する。
 * observationKey の既定値に runId を使うため、同一 run を複数回処理しても
 * Occurrence が重複しない。
 * @param prisma - Prisma クライアント
 * @param input - 対象 run の状態
 */
export async function detectRunFailures(
  prisma: PrismaClient,
  input: DetectRunFailuresInput,
): Promise<void> {
  if (!FAILED_STATUSES.has(input.runStatus)) return

  const severity = input.severity ?? 'high'
  const observationKey = input.observationKey ?? input.runId
  const fingerprint = computeFingerprint('run_failure', {
    component: input.component,
    runId: input.runId,
  })

  const issue = await prisma.operationalIssue.upsert({
    where: { fingerprint },
    create: {
      component: input.component,
      type: 'run_failure',
      fingerprint,
      status: 'active',
      severity,
      firstDetectedAt: input.now,
      lastDetectedAt: input.now,
    },
    update: {
      status: 'active',
      severity,
      lastDetectedAt: input.now,
      resolvedAt: null,
    },
  })

  await prisma.operationalIssueOccurrence.upsert({
    where: { issueId_observationKey: { issueId: issue.id, observationKey } },
    create: {
      issueId: issue.id,
      observedAt: input.now,
      stateTransition: 'activated',
      severity,
      sourceType: input.component,
      sourceId: input.runId,
      measurements: input.errorSummary ? { errorSummary: input.errorSummary } : {},
      observationKey,
    },
    update: {},
  })
}

/** detectAnalysisStageFailure の入力。 */
export interface DetectAnalysisStageFailureInput {
  /** 失敗した WorkItem の kind。 */
  kind: string
  /** 失敗した WorkItem の ID。 */
  workItemId: string
  /** 何回目の試行で失敗したか。 */
  attemptNumber: number
  /** WorkItem の終了状態。 */
  status: 'succeeded' | 'failed' | 'dead'
  /** 記録するエラー概要。 */
  errorSummary: string | undefined
  /** 判定の基準時刻。 */
  now: Date
}

/**
 * 同じ WorkItem の transient failure から作られた active な OperationalIssue を、
 * retry の成功で解消する。fingerprint は component + workItemId で固定されており、
 * detectRunFailures が作った issue と同一のものを指す。
 * @param prisma - Prisma クライアント
 * @param fingerprint - 対象 OperationalIssue の fingerprint
 * @param workItemId - 解消の契機となった WorkItem の ID
 * @param attemptNumber - 解消の契機となった試行番号
 * @param now - 判定の基準時刻
 */
async function resolveIssueOnSuccess(
  prisma: PrismaClient,
  fingerprint: string,
  workItemId: string,
  attemptNumber: number,
  now: Date,
): Promise<void> {
  const issue = await prisma.operationalIssue.findUnique({ where: { fingerprint } })
  if (!issue || issue.status === 'resolved') return

  await prisma.operationalIssue.update({
    where: { id: issue.id },
    data: { status: 'resolved', resolvedAt: now },
  })
  await prisma.operationalIssueOccurrence.upsert({
    where: {
      issueId_observationKey: {
        issueId: issue.id,
        observationKey: `${workItemId}:${attemptNumber}:resolved`,
      },
    },
    create: {
      issueId: issue.id,
      observedAt: now,
      stateTransition: 'resolved',
      severity: issue.severity,
      sourceType: issue.component,
      sourceId: workItemId,
      observationKey: `${workItemId}:${attemptNumber}:resolved`,
    },
    update: {},
  })
}

/**
 * analyzer 自身の stage 失敗も Operations 画面から見えるよう OperationalIssue に昇格する。
 * 再試行余地の残る failed と、再試行が尽きた dead を severity で区別する。
 * transient failure の後に同じ WorkItem が成功した場合は、
 * 残り続けると Attention/Overview に解消済みの障害が居座るため、issue を resolved にする。
 * @param prisma - Prisma クライアント
 * @param input - 失敗した WorkItem の情報
 */
export async function detectAnalysisStageFailure(
  prisma: PrismaClient,
  input: DetectAnalysisStageFailureInput,
): Promise<void> {
  const component = `analyzer:${input.kind}`

  if (input.status === 'succeeded') {
    const fingerprint = computeFingerprint('run_failure', { component, runId: input.workItemId })
    await resolveIssueOnSuccess(
      prisma,
      fingerprint,
      input.workItemId,
      input.attemptNumber,
      input.now,
    )
    return
  }

  await detectRunFailures(prisma, {
    component,
    runId: input.workItemId,
    runStatus: input.status,
    errorSummary: input.errorSummary ?? null,
    now: input.now,
    severity: input.status === 'dead' ? 'critical' : 'high',
    // attempt ごとに Occurrence を残さないと、再試行を重ねた事実が
    // 単一の Occurrence に丸められて失敗の頻度が読めなくなる。
    observationKey: `${input.workItemId}:${input.attemptNumber}`,
  })
}
