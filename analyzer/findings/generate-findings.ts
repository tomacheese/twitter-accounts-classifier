import type { LabelMetricSnapshot, Prisma, PrismaClient, ReviewFinding } from '../generated/prisma'
import { computeFingerprint } from './fingerprint'
import {
  applyLifecycleTransition,
  type FindingLifecycleState,
  type FindingLifecycleStatus,
  type DetectorObservation,
} from './lifecycle'
import { evaluateLabelCountDrop } from './detectors/label-count-drop'
import { evaluateReasonDistributionShifts } from './detectors/reason-distribution-shift'
import type { DetectionPolicy, DetectionPolicyRule } from '../policy/schema'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:generate-findings')

/**
 * generateFindingsForAggregateRefresh に渡せるクライアント。
 * runLabelFindingsSerialized の直列化トランザクション内から呼ばれる場合は
 * Prisma.TransactionClient が渡り、それ自体は $transaction を持たないため
 * 単独呼び出しとネストした呼び出しの両方を同じ関数で扱えるようにする。
 */
type FindingsClient = PrismaClient | Prisma.TransactionClient

/**
 * generateFindingsForAggregateRefresh の入力。
 */
export interface GenerateFindingsForAggregateRefreshInput {
  /** この観測の識別子。同一 WorkItem の retry では不変。 */
  triggerWorkItemId: string
  /** 適用する検出ポリシー。 */
  policy: DetectionPolicy
  /** 適用したポリシーの content hash。 */
  policyHash: string
  /** 検出器のバージョン。 */
  detectorVersion: string
  /**
   * この観測の元データ自体の時刻 (通常は対象 CrawlRun の finishedAt)。
   * AccountSummary の sourceWatermarkAt と時間軸を揃えるために記録する。
   * 省略時は呼び出し時点を使うが、これでは backlog 処理中の古い watermark の
   * generation から Occurrence が漏れうるため、呼び出し元では明示的に渡すべき。
   */
  sourceObservedAt?: Date
}

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

/** LabelMetricSnapshot を入力として評価できる rule の type。 */
const LABEL_SNAPSHOT_RULE_TYPES = new Set(['label_count_drop', 'reason_distribution_shift'])

/**
 * crawl サイクルの検出器ループ以外で評価される rule の type。
 * ここに無い enabled な rule は評価経路が欠けているとみなして警告する。
 */
const RULE_TYPES_EVALUATED_ELSEWHERE = new Set(['possible_false_positive', 'read_model_freshness'])

/**
 * baselineWindow ごとに比較対象を選ぶ。
 * 未知の値を既定の直前サイクルへ寄せると、ポリシーの記述と実際の比較対象が
 * 黙って食い違うため、解釈できない値は例外として扱う。
 * @param prisma - Prisma クライアント
 * @param labelDefinitionId - 対象の LabelDefinition
 * @param current - 今回の snapshot
 * @param baselineWindow - policy が指定する比較ウィンドウ
 * @returns 比較対象の snapshot (見つからなければ null)
 */
async function resolveBaselineSnapshot(
  prisma: FindingsClient,
  labelDefinitionId: string,
  current: { triggerWorkItemId: string; observedAt: Date },
  baselineWindow: string | undefined,
): Promise<LabelMetricSnapshot | null> {
  const observedAtUpperBound =
    baselineWindow === 'seven_day'
      ? new Date(current.observedAt.getTime() - SEVEN_DAY_MS)
      : current.observedAt
  if (baselineWindow !== undefined && !['previous_cycle', 'seven_day'].includes(baselineWindow)) {
    throw new Error(`unsupported baselineWindow: ${baselineWindow}`)
  }

  return prisma.labelMetricSnapshot.findFirst({
    where: {
      labelDefinitionId,
      triggerWorkItemId: { not: current.triggerWorkItemId },
      // schedule/weekly/bootstrap 起点の snapshot は sourceCrawlRunId を
      // 持たず、crawl 起因の比較対象として扱うと母集団の性質が揃わない。
      sourceCrawlRunId: { not: null },
      observedAt: { lt: observedAtUpperBound },
      completeness: 'complete',
    },
    orderBy: [{ observedAt: 'desc' }],
  })
}

/**
 * active/recurring の Finding には resolutionThreshold を、まだ立っていない
 * Finding には activationThreshold を適用する。
 * 単一の閾値だけで判定すると、閾値付近の観測で active と resolved を往復する。
 * @param rule - 適用する検出ルール
 * @param status - 直前までの lifecycle 状態
 * @returns 今回の判定に使う相対変化量の閾値
 */
function resolveEffectiveThreshold(rule: DetectionPolicyRule, status: string): number {
  const isMonitoring = status === 'active' || status === 'recurring'
  const hysteresisThreshold = isMonitoring ? rule.resolutionThreshold : rule.activationThreshold
  return hysteresisThreshold ?? rule.relativeThreshold ?? 0
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
 * ReviewFinding は現在の lifecycle 状態そのものを持たないため、
 * 直近の DetectorEvaluation 列から連続回数を数え直して状態を再構築する。
 * 専用の state テーブルを増やさずに済むため。
 * @param tx - トランザクション内の Prisma クライアント
 * @param fingerprint - 対象の fingerprint
 * @param identityVersion - 対象の identityVersion
 * @param existingFinding - 既存の ReviewFinding (無ければ undefined)
 * @returns 直前までの lifecycle 状態
 */
async function reconstructLifecycleState(
  tx: Prisma.TransactionClient,
  fingerprint: string,
  identityVersion: number,
  existingFinding: ReviewFinding | null,
): Promise<FindingLifecycleState> {
  const recent = await tx.detectorEvaluation.findMany({
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

  // active/recurring はいずれも継続監視中の状態で、consecutiveNormal の数え方も共通のため、
  // 既存の status をそのまま引き継ぐ。
  // 'active' に丸めると recurring の表示区分が失われる。
  let consecutiveNormal = 0
  for (const evaluation of recent) {
    const result = evaluation.result as unknown as DetectorObservation
    if (result.isMissingOrFailed) continue
    if (result.exceeded) break
    consecutiveNormal++
  }
  return {
    status: existingFinding.status as FindingLifecycleStatus,
    consecutiveExceed: 0,
    consecutiveNormal,
  }
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
 * @param tx - トランザクション内の Prisma クライアント
 * @param findingId - 対象の ReviewFinding ID
 * @param stateTransition - この観測で生じた状態遷移
 * @param input - この観測に関する全パラメータ
 * @param ctx - 実行全体で共通のパラメータ
 * @param now - 観測時刻
 */
async function upsertOccurrence(
  tx: Prisma.TransactionClient,
  findingId: string,
  stateTransition: string,
  input: ProcessObservationInput,
  ctx: GenerateFindingsForAggregateRefreshInput,
  now: Date,
): Promise<void> {
  // 同一 triggerWorkItemId の retry で Occurrence が重複しないよう、
  // triggerWorkItemId (= sourceId) を observationKey として使う。
  const occurrence = await tx.reviewFindingOccurrence.upsert({
    where: { findingId_observationKey: { findingId, observationKey: input.sourceId } },
    create: {
      findingId,
      observedAt: now,
      sourceObservedAt: ctx.sourceObservedAt ?? now,
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

  if (input.primaryScopeType === 'account') {
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
}

/**
 * @param prisma - Prisma クライアント
 * @param input - この観測に関する全パラメータ
 * @param ctx - 実行全体で共通のパラメータ
 */
async function processObservation(
  prisma: FindingsClient,
  input: ProcessObservationInput,
  ctx: GenerateFindingsForAggregateRefreshInput,
): Promise<void> {
  const fingerprint = computeFingerprint(input.type, input.dimensions)

  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    // WorkItem の at-least-once retry で同じ sourceId が再度渡されたとき、
    // lifecycle 遷移を再適用すると consecutiveExceed/recurrenceCount が
    // 二重に進んでしまう。DetectorEvaluation の一意キーで既処理を検出し、
    // Finding 更新より前段でスキップする。
    const existingEvaluation = await tx.detectorEvaluation.findUnique({
      where: {
        fingerprint_identityVersion_sourceId_isShadow: {
          fingerprint,
          identityVersion: input.rule.identityVersion,
          sourceId: input.sourceId,
          isShadow: false,
        },
      },
    })
    if (existingEvaluation) return

    const existingFinding = await tx.reviewFinding.findFirst({
      where: { fingerprint, identityVersion: input.rule.identityVersion },
      orderBy: [{ episodeNumber: 'desc' }],
    })

    // 今回の観測を書き込む前の履歴から状態を再構築する必要があるため、
    // DetectorEvaluation の書き込みより前に評価する。
    const priorState = await reconstructLifecycleState(
      tx,
      fingerprint,
      input.rule.identityVersion,
      existingFinding,
    )
    const now = new Date()
    const observation = {
      ...input.observation,
      exceeded:
        !input.observation.isMissingOrFailed &&
        input.observation.relativeDifference >=
          resolveEffectiveThreshold(input.rule, priorState.status),
    }
    const next = applyLifecycleTransition(priorState, observation, input.rule, now)

    // active 化前の候補であっても、後から連続超過回数を再構築できるよう必ず保存する。
    await tx.detectorEvaluation.create({
      data: {
        detectorType: input.rule.detectorType,
        fingerprint,
        identityVersion: input.rule.identityVersion,
        sourceId: input.sourceId,
        isShadow: false,
        result: observation as unknown as Prisma.InputJsonValue,
        policyHash: ctx.policyHash,
      },
    })

    if (next.status === 'none') return

    if (existingFinding && next.status !== 'new_episode') {
      await tx.reviewFinding.update({
        where: { id: existingFinding.id },
        data: {
          status: next.status,
          currentSeverity: input.rule.severity,
          maximumSeverity: maxSeverity(existingFinding.maximumSeverity, input.rule.severity),
          lastDetectedAt: now,
          resolvedAt: next.status === 'resolved' ? now : null,
          recurrenceCount:
            next.status === 'recurring' && priorState.status !== 'recurring'
              ? existingFinding.recurrenceCount + 1
              : existingFinding.recurrenceCount,
        },
      })
      await upsertOccurrence(tx, existingFinding.id, next.status, input, ctx, now)
      return
    }

    const episodeNumber = existingFinding ? existingFinding.episodeNumber + 1 : 1
    const created = await tx.reviewFinding.create({
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
      await tx.reviewFinding.update({
        where: { id: existingFinding.id },
        data: { supersededByFindingId: created.id },
      })
    }
    await upsertOccurrence(tx, created.id, next.status, input, ctx, now)
  }

  // Prisma.TransactionClient には $transaction 自体が無い。
  // 既にトランザクション内なら run をそのまま実行し、そうでなければここで開く。
  await ('$transaction' in prisma ? prisma.$transaction(run) : run(prisma))
}

/**
 * Label aggregate の snapshot set 確定を契機に Label 別 metric snapshot から
 * 検出器を実行し、ReviewFinding/ReviewFindingOccurrence/DetectorEvaluation を
 * 更新する。
 * @param prisma - Prisma クライアント
 * @param input - 対象 snapshot set と検出ポリシー
 */
export async function generateFindingsForAggregateRefresh(
  prisma: FindingsClient,
  input: GenerateFindingsForAggregateRefreshInput,
): Promise<void> {
  // complete 以外は母集団が欠けた記録であり、実測値として検出器へ渡すと
  // 巡回できなかった分の減少や分析エラーを品質劣化として誤検出させる。
  const currentSnapshots = await prisma.labelMetricSnapshot.findMany({
    where: { triggerWorkItemId: input.triggerWorkItemId, completeness: 'complete' },
  })

  // 同じ種別を Label 数だけ繰り返し警告しないよう、実行全体で 1 回にまとめる。
  const unimplementedRuleTypes = new Set<string>()

  for (const snapshot of currentSnapshots) {
    for (const rule of input.policy.rules) {
      if (!rule.enabled) continue
      if (!LABEL_SNAPSHOT_RULE_TYPES.has(rule.type)) {
        if (!RULE_TYPES_EVALUATED_ELSEWHERE.has(rule.type)) unimplementedRuleTypes.add(rule.type)
        continue
      }

      const baseline = await resolveBaselineSnapshot(
        prisma,
        snapshot.labelDefinitionId,
        snapshot,
        rule.baselineWindow,
      )

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
            sourceId: input.triggerWorkItemId,
          },
          input,
        )
        continue
      }

      if (rule.type === 'reason_distribution_shift') {
        const results = evaluateReasonDistributionShifts(
          {
            current: snapshot.reasonDistribution as unknown as Record<string, number>,
            baseline: (baseline?.reasonDistribution ?? {}) as unknown as Record<string, number>,
          },
          {
            relativeThreshold: rule.relativeThreshold ?? 0,
            minimumSampleSize: rule.minimumSampleSize ?? 0,
          },
        )
        // reason ごとに独立した fingerprint を持つため、比較可能な reason 全件へ
        // observation を送る。最大変化幅の reason だけに絞ると、直前まで
        // 有効だった他 reason の Finding が二度と観測を受け取れず resolved に
        // 遷移できなくなる。
        for (const result of results) {
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
              sourceId: input.triggerWorkItemId,
            },
            input,
          )
        }
      }
    }
  }

  for (const ruleType of unimplementedRuleTypes) {
    logger.warn(`no detector implemented for enabled policy rule type: ${ruleType}`)
  }
}

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
  /** この観測の元データ自体の時刻。 */
  sourceObservedAt?: Date
}

/**
 * crawlRunId を triggerWorkItemId として generateFindingsForAggregateRefresh へ
 * 委譲する薄いラッパー。
 * @param prisma - Prisma クライアント
 * @param input - 対象 crawl run と検出ポリシー
 */
export async function generateFindingsForCrawlCycle(
  prisma: PrismaClient,
  input: GenerateFindingsForCrawlCycleInput,
): Promise<void> {
  await generateFindingsForAggregateRefresh(prisma, {
    triggerWorkItemId: input.crawlRunId,
    policy: input.policy,
    policyHash: input.policyHash,
    detectorVersion: input.detectorVersion,
    sourceObservedAt: input.sourceObservedAt,
  })
}
