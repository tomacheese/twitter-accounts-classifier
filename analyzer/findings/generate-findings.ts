import type { Prisma, PrismaClient, ReviewFinding } from '../generated/prisma'
import { computeFingerprint } from './fingerprint'
import {
  applyLifecycleTransition,
  type FindingLifecycleState,
  type DetectorObservation,
} from './lifecycle'
import { evaluateLabelCountDrop } from './detectors/label-count-drop'
import { evaluateReasonDistributionShift } from './detectors/reason-distribution-shift'
import type { DetectionPolicy, DetectionPolicyRule } from '../policy/schema'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:generate-findings')

/**
 * generateFindingsForCrawlCycle の入力。
 */
export interface GenerateFindingsForCrawlCycleInput {
  /** 対象の CrawlRun ID。 */
  crawlRunId: string
  /** 適用する検出ポリシー。 */
  policy: DetectionPolicy
  /** 適用したポリシーの content hash。 */
  policyHash: string
  /** 検出器のバージョン。 */
  detectorVersion: string
}

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/**
 * @param a - 比較対象の severity
 * @param b - 比較対象の severity
 * @returns 2 つのうちより深刻な severity
 */
function maxSeverity(a: string, b: string): string {
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b
}

/**
 * ReviewFinding は現在の lifecycle 状態そのものを持たないため、
 * 直近の DetectorEvaluation 列から連続回数を数え直して状態を再構築する。
 * 専用の state テーブルを増やさずに済むため。
 * @param prisma - Prisma クライアント
 * @param fingerprint - 対象の fingerprint
 * @param identityVersion - 対象の identityVersion
 * @param existingFinding - 既存の ReviewFinding (無ければ undefined)
 * @returns 直前までの lifecycle 状態
 */
async function reconstructLifecycleState(
  prisma: PrismaClient,
  fingerprint: string,
  identityVersion: number,
  existingFinding: ReviewFinding | null,
): Promise<FindingLifecycleState> {
  const recent = await prisma.detectorEvaluation.findMany({
    where: { fingerprint, identityVersion, isShadow: false },
    orderBy: [{ evaluatedAt: 'desc' }],
    take: 50,
  })

  if (!existingFinding || existingFinding.status === 'resolved') {
    let consecutiveExceed = 0
    for (const evaluation of recent) {
      const result = evaluation.result as unknown as DetectorObservation
      if (result.isMissingOrFailed) continue
      if (!result.exceeded) break
      consecutiveExceed++
    }
    return existingFinding
      ? {
          status: 'resolved',
          consecutiveExceed,
          consecutiveNormal: 0,
          resolvedAt: existingFinding.resolvedAt ?? undefined,
        }
      : { status: 'none', consecutiveExceed, consecutiveNormal: 0 }
  }

  let consecutiveNormal = 0
  for (const evaluation of recent) {
    const result = evaluation.result as unknown as DetectorObservation
    if (result.isMissingOrFailed) continue
    if (result.exceeded) break
    consecutiveNormal++
  }
  return { status: 'active', consecutiveExceed: 0, consecutiveNormal }
}

interface ProcessObservationInput {
  type: string
  dimensions: Record<string, string>
  primaryScopeType: string
  primaryScopeId: string
  observation: DetectorObservation & {
    observedValue: number
    baselineValue: number
    relativeDifference: number
    affectedCount: number
    totalCount: number
  }
  rule: DetectionPolicyRule
  sourceType: string
  sourceId: string
}

/**
 * @param prisma - Prisma クライアント
 * @param findingId - 対象の ReviewFinding ID
 * @param stateTransition - この観測で生じた状態遷移
 * @param input - この観測に関する全パラメータ
 * @param ctx - 実行全体で共通のパラメータ
 * @param now - 観測時刻
 */
async function upsertOccurrence(
  prisma: PrismaClient,
  findingId: string,
  stateTransition: string,
  input: ProcessObservationInput,
  ctx: GenerateFindingsForCrawlCycleInput,
  now: Date,
): Promise<void> {
  // 同一 crawlRunId の再実行で Occurrence が重複しないよう、
  // crawlRunId (= sourceId) を observationKey として使う。
  await prisma.reviewFindingOccurrence.upsert({
    where: { findingId_observationKey: { findingId, observationKey: input.sourceId } },
    create: {
      findingId,
      observedAt: now,
      stateTransition,
      severity: input.rule.severity,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      observedValue: input.observation.observedValue,
      baselineValue: input.observation.baselineValue,
      relativeDifference: input.observation.relativeDifference,
      affectedCount: input.observation.affectedCount,
      totalCount: input.observation.totalCount,
      policyHash: ctx.policyHash,
      detectorVersion: ctx.detectorVersion,
      observationKey: input.sourceId,
    },
    update: {},
  })
}

/**
 * @param prisma - Prisma クライアント
 * @param input - この観測に関する全パラメータ
 * @param ctx - 実行全体で共通のパラメータ
 */
async function processObservation(
  prisma: PrismaClient,
  input: ProcessObservationInput,
  ctx: GenerateFindingsForCrawlCycleInput,
): Promise<void> {
  const fingerprint = computeFingerprint(input.type, input.dimensions)

  const existingFinding = await prisma.reviewFinding.findFirst({
    where: { fingerprint, identityVersion: input.rule.identityVersion },
    orderBy: [{ episodeNumber: 'desc' }],
  })

  // 今回の観測を書き込む前の履歴から状態を再構築する必要があるため、
  // DetectorEvaluation の書き込みより前に評価する。
  const priorState = await reconstructLifecycleState(
    prisma,
    fingerprint,
    input.rule.identityVersion,
    existingFinding,
  )
  const now = new Date()
  const next = applyLifecycleTransition(priorState, input.observation, input.rule, now)

  // active 化前の候補であっても、後から連続超過回数を再構築できるよう必ず保存する。
  await prisma.detectorEvaluation.create({
    data: {
      detectorType: input.rule.detectorType,
      fingerprint,
      identityVersion: input.rule.identityVersion,
      isShadow: false,
      result: input.observation as unknown as Prisma.InputJsonValue,
      policyHash: ctx.policyHash,
    },
  })

  if (next.status === 'none') return

  if (existingFinding && next.status !== 'new_episode') {
    await prisma.reviewFinding.update({
      where: { id: existingFinding.id },
      data: {
        status: next.status,
        currentSeverity: input.rule.severity,
        maximumSeverity: maxSeverity(existingFinding.maximumSeverity, input.rule.severity),
        lastDetectedAt: now,
        resolvedAt: next.status === 'resolved' ? now : null,
        recurrenceCount:
          next.status === 'recurring'
            ? existingFinding.recurrenceCount + 1
            : existingFinding.recurrenceCount,
      },
    })
    await upsertOccurrence(prisma, existingFinding.id, next.status, input, ctx, now)
    return
  }

  const episodeNumber = existingFinding ? existingFinding.episodeNumber + 1 : 1
  const created = await prisma.reviewFinding.create({
    data: {
      fingerprint,
      identityVersion: input.rule.identityVersion,
      episodeNumber,
      type: input.type,
      primaryScopeType: input.primaryScopeType,
      primaryScopeId: input.primaryScopeId,
      status: 'active',
      currentSeverity: input.rule.severity,
      maximumSeverity: input.rule.severity,
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
  await upsertOccurrence(prisma, created.id, next.status, input, ctx, now)
}

/**
 * Crawl サイクル完了を契機に Label 別 metric snapshot から検出器を実行し、
 * ReviewFinding/ReviewFindingOccurrence/DetectorEvaluation を更新する。
 * @param prisma - Prisma クライアント
 * @param input - 対象 crawl run と検出ポリシー
 */
export async function generateFindingsForCrawlCycle(
  prisma: PrismaClient,
  input: GenerateFindingsForCrawlCycleInput,
): Promise<void> {
  // completeness: 'unknown' は集計自体に失敗した記録であり、
  // 実測値として検出器へ渡すと分析エラーを品質劣化として誤検出させる。
  const currentSnapshots = await prisma.labelMetricSnapshot.findMany({
    where: { sourceCrawlRunId: input.crawlRunId, completeness: { not: 'unknown' } },
  })

  // 同じ種別を Label 数だけ繰り返し警告しないよう、実行全体で 1 回にまとめる。
  const unimplementedRuleTypes = new Set<string>()

  for (const snapshot of currentSnapshots) {
    const baseline = await prisma.labelMetricSnapshot.findFirst({
      where: {
        labelDefinitionId: snapshot.labelDefinitionId,
        sourceCrawlRunId: { not: input.crawlRunId },
        observedAt: { lt: snapshot.observedAt },
        completeness: { not: 'unknown' },
      },
      orderBy: [{ observedAt: 'desc' }],
    })

    for (const rule of input.policy.rules) {
      if (!rule.enabled) continue

      if (rule.type === 'label_count_drop') {
        const result = evaluateLabelCountDrop(
          {
            current: { trueCount: snapshot.trueCount, evaluatedCount: snapshot.evaluatedCount },
            baseline: {
              trueCount: baseline?.trueCount ?? 0,
              evaluatedCount: baseline?.evaluatedCount ?? 0,
            },
          },
          {
            relativeThreshold: rule.relativeThreshold ?? 0,
            minimumSampleSize: rule.minimumSampleSize ?? 0,
          },
        )
        await processObservation(
          prisma,
          {
            type: rule.type,
            dimensions: { label: snapshot.labelDefinitionId },
            primaryScopeType: 'label',
            primaryScopeId: snapshot.labelDefinitionId,
            observation: result,
            rule,
            sourceType: 'crawl_run',
            sourceId: input.crawlRunId,
          },
          input,
        )
        continue
      }

      if (rule.type === 'reason_distribution_shift') {
        const result = evaluateReasonDistributionShift(
          {
            current: snapshot.reasonDistribution as unknown as Record<string, number>,
            baseline: (baseline?.reasonDistribution ?? {}) as unknown as Record<string, number>,
          },
          {
            relativeThreshold: rule.relativeThreshold ?? 0,
            minimumSampleSize: rule.minimumSampleSize ?? 0,
          },
        )
        if (!result.reason) continue
        await processObservation(
          prisma,
          {
            type: rule.type,
            dimensions: { label: snapshot.labelDefinitionId, reason: result.reason },
            primaryScopeType: 'label',
            primaryScopeId: snapshot.labelDefinitionId,
            observation: result,
            rule,
            sourceType: 'crawl_run',
            sourceId: input.crawlRunId,
          },
          input,
        )
        continue
      }

      unimplementedRuleTypes.add(rule.type)
    }
  }

  for (const ruleType of unimplementedRuleTypes) {
    logger.warn(`no detector implemented for enabled policy rule type: ${ruleType}`)
  }
}
