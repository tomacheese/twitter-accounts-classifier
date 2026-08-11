import type { Prisma, PrismaClient, ReviewFinding } from '../generated/prisma'
import { computeFingerprint } from '../findings/fingerprint'
import { applyLifecycleTransition, type FindingLifecycleState } from '../findings/lifecycle'
import { computePolicyHash } from '../policy/policy-hash'
import type { DetectionPolicy, DetectionPolicyRule } from '../policy/schema'
import type { StructuredOutput, WeeklyReviewFindingCandidate } from './structured-output-schema'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:weekly-review-ingest')

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
  // recurring を active に丸めると、この Weekly Review の取り込みが
  // 再発済みという情報を上書きして消してしまう。
  if (existingFinding.status === 'recurring') {
    return { status: 'recurring', consecutiveExceed: 0, consecutiveNormal: 0 }
  }
  return { status: 'active', consecutiveExceed: 0, consecutiveNormal: 0 }
}

/**
 * ingestWeeklyReviewFindings の入力。
 */
export interface IngestWeeklyReviewFindingsInput {
  /** 取り込み元の WeeklyAnalysisRun ID。 */
  weeklyAnalysisRunId: string
  /** 検証済みの structuredOutput。 */
  structuredOutput: StructuredOutput
  /** 適用する検出ポリシー。 */
  policy: DetectionPolicy
  /**
   * この観測の元データ自体の時刻 (通常は対象 WeeklyAnalysisRun の finishedAt)。
   * 省略時は呼び出し時点を使うが、これでは AccountSummary の sourceWatermarkAt との
   * 時間軸がずれるため、呼び出し元では明示的に渡すべき。
   */
  sourceObservedAt?: Date
}

/**
 * 1 件の finding candidate を fingerprint で既存 Finding と突き合わせ、
 * 裏付け (既存 Occurrence の有無) に応じて severity を決定し、
 * Finding・Occurrence・Evidence を保存する。
 * 同じ WeeklyAnalysisRun による at-least-once retry でも、Finding 更新・Occurrence 記録・
 * Evidence 追加が揃って一度だけ成立するよう、判定と書き込みを1つの transaction にまとめる。
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

  await prisma.$transaction(async (tx) => {
    const existingFinding = await tx.reviewFinding.findFirst({
      where: { fingerprint, identityVersion: rule.identityVersion },
      orderBy: [{ episodeNumber: 'desc' }],
    })

    // この run が既にこの finding へ Occurrence を記録済みなら、retry による
    // 同一証拠の二重裏付け・recurrenceCount の多重加算・Evidence 重複を避けて何もしない。
    if (existingFinding) {
      const alreadyIngested = await tx.reviewFindingOccurrence.findUnique({
        where: {
          findingId_observationKey: {
            findingId: existingFinding.id,
            observationKey: ctx.weeklyAnalysisRunId,
          },
        },
      })
      if (alreadyIngested) return
    }

    // 既存 Occurrence が 1 件以上あれば、今回とは独立した過去の観測で裏付けられていると判断し、
    // 単独の LLM 推定に課す上限 (maxWeeklyReviewSeverityWithoutCorroboration) を外す。
    const isCorroborated = existingFinding
      ? (await tx.reviewFindingOccurrence.count({ where: { findingId: existingFinding.id } })) > 0
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
      await tx.reviewFinding.update({
        where: { id: existingFinding.id },
        data: {
          status: next.status,
          currentSeverity: appliedSeverity,
          maximumSeverity: maxSeverity(existingFinding.maximumSeverity, appliedSeverity),
          lastDetectedAt: now,
          resolvedAt: next.status === 'resolved' ? now : null,
          recurrenceCount:
            next.status === 'recurring' && priorState.status !== 'recurring'
              ? existingFinding.recurrenceCount + 1
              : existingFinding.recurrenceCount,
        },
      })
      findingId = existingFinding.id
    } else {
      const episodeNumber = existingFinding ? existingFinding.episodeNumber + 1 : 1
      const created = await tx.reviewFinding.create({
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
        await tx.reviewFinding.update({
          where: { id: existingFinding.id },
          data: { supersededByFindingId: created.id },
        })
      }
      findingId = created.id
    }

    const occurrence = await tx.reviewFindingOccurrence.create({
      data: {
        findingId,
        observedAt: now,
        sourceObservedAt: ctx.sourceObservedAt ?? now,
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
    })

    if (candidate.primaryScopeType === 'account') {
      await tx.analysisWorkItem.upsert({
        where: {
          kind_triggerType_triggerId: {
            kind: 'account_summary_refresh',
            triggerType: 'review_finding_occurrence',
            triggerId: occurrence.id,
          },
        },
        create: {
          kind: 'account_summary_refresh',
          triggerType: 'review_finding_occurrence',
          triggerId: occurrence.id,
        },
        update: {},
      })
    }

    await tx.findingEvidence.create({
      data: {
        findingId,
        kind: 'weekly_review_structured_output',
        schemaVersion: ctx.structuredOutput.schemaVersion,
        redactionVersion: 1,
        sampleStrategyVersion: ctx.structuredOutput.review?.strategyVersion,
        payload: {
          evidenceReference: candidate.evidenceReference,
          sampleReference: candidate.sampleReference,
          structuredMeasurement: candidate.structuredMeasurement,
        } as Prisma.InputJsonValue,
      },
    })
  })
}

/**
 * WeeklyAnalysisRun の structuredOutput を確度に応じて取り込み、
 * ReviewFinding・ReviewFindingOccurrence・FindingEvidence を更新する。
 * unavailableReason が設定された candidate (確度不足などで判定不能) と、
 * 有効な policy rule が無い type の candidate は取り込まない。
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
    if (!rule) {
      logger.warn(
        `dropped weekly review candidate ${candidate.primaryScopeType}:${candidate.primaryScopeId}: no enabled policy rule for type ${candidate.type}`,
      )
      continue
    }

    await ingestOneFinding(prisma, candidate, rule, { ...input, policyHash })
  }
}
