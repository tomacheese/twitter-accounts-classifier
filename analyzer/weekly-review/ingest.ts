import type { Prisma, PrismaClient, ReviewFinding } from '../generated/prisma'
import { computeFingerprint } from '../findings/fingerprint'
import { applyLifecycleTransition, type FindingLifecycleState } from '../findings/lifecycle'
import { computePolicyHash } from '../policy/policy-hash'
import type { DetectionPolicy, DetectionPolicyRule } from '../policy/schema'
import type { StructuredOutput, WeeklyReviewFindingCandidate } from './structured-output-schema'

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/**
 * @param suggested - LLM が提案した severity
 * @param cap - 裏付けが無いときに超えてはならない上限 severity (未設定なら上限なし)
 * @returns 実際に適用する severity
 */
function capSeverity(suggested: string, cap: string | undefined): string {
  if (!cap) return suggested
  return (SEVERITY_RANK[suggested] ?? 0) <= (SEVERITY_RANK[cap] ?? 0) ? suggested : cap
}

/**
 * @param a - 比較対象の severity
 * @param b - 比較対象の severity
 * @returns 2 つのうちより深刻な severity
 */
function maxSeverity(a: string, b: string): string {
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b
}

/**
 * Weekly Review は crawl 起点の DetectorEvaluation 履歴を持たないため、
 * 既存 Finding の現在 status だけから lifecycle の起点状態を組み立てる。
 * @param existingFinding - 同一 fingerprint の既存 Finding (無ければ null)
 * @returns lifecycle 遷移の起点となる状態
 */
function deriveWeeklyPriorState(existingFinding: ReviewFinding | null): FindingLifecycleState {
  if (!existingFinding) return { status: 'none', consecutiveExceed: 0, consecutiveNormal: 0 }
  if (existingFinding.status === 'resolved') {
    return {
      status: 'resolved',
      consecutiveExceed: 0,
      consecutiveNormal: 0,
      resolvedAt: existingFinding.resolvedAt ?? undefined,
    }
  }
  return { status: 'active', consecutiveExceed: 0, consecutiveNormal: 0 }
}

export interface IngestWeeklyReviewFindingsInput {
  weeklyAnalysisRunId: string
  structuredOutput: StructuredOutput
  policy: DetectionPolicy
}

/**
 * 1 件の finding candidate を fingerprint で既存 Finding と突き合わせ、
 * 裏付け (既存 Occurrence の有無) に応じて severity を決定し、
 * Finding・Occurrence・Evidence を保存する。
 * @param prisma - Prisma クライアント
 * @param candidate - structuredOutput 内の 1 件の finding candidate
 * @param rule - candidate.type に対応する検出 policy rule
 * @param ctx - 呼び出し全体で共通のパラメータ
 */
async function ingestOneFinding(
  prisma: PrismaClient,
  candidate: WeeklyReviewFindingCandidate,
  rule: DetectionPolicyRule,
  ctx: IngestWeeklyReviewFindingsInput & { policyHash: string },
): Promise<void> {
  const fingerprint = computeFingerprint(candidate.type, candidate.dimensions)

  const existingFinding = await prisma.reviewFinding.findFirst({
    where: { fingerprint, identityVersion: rule.identityVersion },
    orderBy: [{ episodeNumber: 'desc' }],
  })

  // 既存 Occurrence が 1 件以上あれば、今回とは独立した過去の観測で裏付けられていると判断し、
  // 単独の LLM 推定に課す上限 (maxWeeklyReviewSeverityWithoutCorroboration) を外す。
  const isCorroborated = existingFinding
    ? (await prisma.reviewFindingOccurrence.count({ where: { findingId: existingFinding.id } })) > 0
    : false
  const appliedSeverity = isCorroborated
    ? candidate.suggestedSeverity
    : capSeverity(candidate.suggestedSeverity, rule.maxWeeklyReviewSeverityWithoutCorroboration)

  const priorState = deriveWeeklyPriorState(existingFinding)
  const now = new Date()
  const next = applyLifecycleTransition(
    priorState,
    { exceeded: true, isMissingOrFailed: false },
    rule,
    now,
  )
  if (next.status === 'none') return

  let findingId: string
  if (existingFinding && next.status !== 'new_episode') {
    await prisma.reviewFinding.update({
      where: { id: existingFinding.id },
      data: {
        status: next.status === 'resolved' ? 'resolved' : 'active',
        currentSeverity: appliedSeverity,
        maximumSeverity: maxSeverity(existingFinding.maximumSeverity, appliedSeverity),
        lastDetectedAt: now,
        resolvedAt: next.status === 'resolved' ? now : null,
        recurrenceCount:
          next.status === 'recurring'
            ? existingFinding.recurrenceCount + 1
            : existingFinding.recurrenceCount,
      },
    })
    findingId = existingFinding.id
  } else {
    const episodeNumber = existingFinding ? existingFinding.episodeNumber + 1 : 1
    const created = await prisma.reviewFinding.create({
      data: {
        fingerprint,
        identityVersion: rule.identityVersion,
        episodeNumber,
        type: candidate.type,
        primaryScopeType: candidate.primaryScopeType,
        primaryScopeId: candidate.primaryScopeId,
        status: 'active',
        currentSeverity: appliedSeverity,
        maximumSeverity: appliedSeverity,
        firstDetectedAt: now,
        lastDetectedAt: now,
        previousFindingId: existingFinding?.id,
      },
    })
    if (existingFinding) {
      await prisma.reviewFinding.update({
        where: { id: existingFinding.id },
        data: { supersededByFindingId: created.id },
      })
    }
    findingId = created.id
  }

  await prisma.reviewFindingOccurrence.upsert({
    where: { findingId_observationKey: { findingId, observationKey: ctx.weeklyAnalysisRunId } },
    create: {
      findingId,
      observedAt: now,
      stateTransition: next.status,
      severity: appliedSeverity,
      sourceType: 'weekly_analysis_run',
      sourceId: ctx.weeklyAnalysisRunId,
      confidence: candidate.confidence,
      affectedCount: candidate.sampleCount,
      totalCount: candidate.sampleCount,
      policyHash: ctx.policyHash,
      detectorVersion: ctx.structuredOutput.toolIdentity,
      observationKey: ctx.weeklyAnalysisRunId,
    },
    update: {},
  })

  await prisma.findingEvidence.create({
    data: {
      findingId,
      kind: 'weekly_review_structured_output',
      schemaVersion: ctx.structuredOutput.schemaVersion,
      redactionVersion: 1,
      payload: {
        evidenceReference: candidate.evidenceReference,
        sampleReference: candidate.sampleReference,
        structuredMeasurement: candidate.structuredMeasurement,
      } as Prisma.InputJsonValue,
    },
  })
}

/**
 * WeeklyAnalysisRun の structuredOutput を取り込み、確度に応じて
 * ReviewFinding・ReviewFindingOccurrence・FindingEvidence を更新する。
 * unavailableReason が設定された candidate (確度不足などで判定不能) は取り込まない。
 * @param prisma - Prisma クライアント
 * @param input - 対象 WeeklyAnalysisRun と structuredOutput、適用する policy
 */
export async function ingestWeeklyReviewFindings(
  prisma: PrismaClient,
  input: IngestWeeklyReviewFindingsInput,
): Promise<void> {
  const policyHash = computePolicyHash(input.policy)

  for (const candidate of input.structuredOutput.findings) {
    if (candidate.unavailableReason) continue

    const rule = input.policy.rules.find(
      (candidateRule) => candidateRule.type === candidate.type && candidateRule.enabled,
    )
    if (!rule) continue

    await ingestOneFinding(prisma, candidate, rule, { ...input, policyHash })
  }
}
