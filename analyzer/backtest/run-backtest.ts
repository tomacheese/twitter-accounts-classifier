import type { PrismaClient } from '../generated/prisma'
import { evaluateLabelCountDrop } from '../findings/detectors/label-count-drop'
import { evaluateReasonDistributionShifts } from '../findings/detectors/reason-distribution-shift'
import { computeFingerprint } from '../findings/fingerprint'
import { computePolicyHash } from '../policy/policy-hash'
import type { DetectionPolicy } from '../policy/schema'

/**
 * runBacktest の入力。
 */
export interface RunBacktestInput {
  /** replay 対象期間の開始時刻。 */
  targetFrom: Date
  /** replay 対象期間の終了時刻。 */
  targetTo: Date
  /** replay 対象の LabelDefinition ID 一覧。 */
  labelDefinitionIds: string[]
  /** 評価したい候補 policy。 */
  candidatePolicy: DetectionPolicy
  /** 比較基準となる現行 policy。 */
  baselinePolicy: DetectionPolicy
}

/**
 * candidatePolicy と baselinePolicy それぞれで snapshot pair を評価し、
 * exceeded 判定が食い違った場合だけ diff とみなす。
 * @param current - 現在の snapshot 相当の入力
 * @param baseline - 比較対象の snapshot 相当の入力
 * @param policy - 評価対象の policy
 * @param labelDefinitionId - 評価対象ラベル
 * @returns type ごとの exceeded 判定 (rule が無効/未定義なら false)
 */
function evaluateAllRules(
  current: {
    trueCount: number
    evaluatedCount: number
    reasonDistribution: Record<string, number>
  },
  baseline: {
    trueCount: number
    evaluatedCount: number
    reasonDistribution: Record<string, number>
  },
  policy: DetectionPolicy,
): { type: string; reason?: string; exceeded: boolean }[] {
  const results: { type: string; reason?: string; exceeded: boolean }[] = []

  const labelCountDropRule = policy.rules.find(
    (rule) => rule.type === 'label_count_drop' && rule.enabled,
  )
  if (labelCountDropRule) {
    const result = evaluateLabelCountDrop(
      { current, baseline },
      {
        relativeThreshold: labelCountDropRule.relativeThreshold ?? 0,
        minimumSampleSize: labelCountDropRule.minimumSampleSize ?? 0,
      },
    )
    results.push({ type: 'label_count_drop', exceeded: result.exceeded })
  }

  const reasonShiftRule = policy.rules.find(
    (rule) => rule.type === 'reason_distribution_shift' && rule.enabled,
  )
  if (reasonShiftRule) {
    const shiftResults = evaluateReasonDistributionShifts(
      { current: current.reasonDistribution, baseline: baseline.reasonDistribution },
      {
        relativeThreshold: reasonShiftRule.relativeThreshold ?? 0,
        minimumSampleSize: reasonShiftRule.minimumSampleSize ?? 0,
      },
    )
    for (const result of shiftResults) {
      results.push({
        type: 'reason_distribution_shift',
        reason: result.reason,
        exceeded: result.exceeded,
      })
    }
  }

  return results
}

/**
 * reason_distribution_shift は reason ごとに結果を持つため、type だけでなく
 * reason も揃えて fingerprint を作らないと別 reason 同士を同一視してしまう。
 * @param labelDefinitionId - 対象ラベル
 * @param result - fingerprint を作る対象の判定結果
 * @returns computeFingerprint に渡す dimensions
 */
function fingerprintDimensions(
  labelDefinitionId: string,
  result: { type: string; reason?: string },
): Record<string, string> {
  return result.reason
    ? { label: labelDefinitionId, reason: result.reason }
    : { label: labelDefinitionId }
}

/**
 * 過去 snapshot を replay し、判定差分を PolicyBacktestRun へ記録する。
 * 本番の Finding や Pointer を書き換えないことは、
 * それらを操作する関数を一切 import しないことでコード上も保証する。
 * @param prisma - Prisma クライアント
 * @param input - 対象期間・対象ラベルと比較する 2 つの policy
 * @returns 作成した PolicyBacktestRun の ID
 */
export async function runBacktest(prisma: PrismaClient, input: RunBacktestInput): Promise<string> {
  const candidatePolicyHash = computePolicyHash(input.candidatePolicy)
  const baselinePolicyHash = computePolicyHash(input.baselinePolicy)

  const run = await prisma.policyBacktestRun.create({
    data: {
      candidatePolicyHash,
      baselinePolicyHash,
      targetFrom: input.targetFrom,
      targetTo: input.targetTo,
      status: 'running',
    },
  })

  let findingCount = 0
  for (const labelDefinitionId of input.labelDefinitionIds) {
    const snapshots = await prisma.labelMetricSnapshot.findMany({
      where: {
        labelDefinitionId,
        observedAt: { gte: input.targetFrom, lte: input.targetTo },
      },
      orderBy: [{ observedAt: 'asc' }],
    })

    for (let index = 1; index < snapshots.length; index++) {
      const current = snapshots.at(index)
      const baseline = snapshots.at(index - 1)
      if (!current || !baseline) continue

      const currentInput = {
        trueCount: current.trueCount,
        evaluatedCount: current.evaluatedCount,
        reasonDistribution: current.reasonDistribution as unknown as Record<string, number>,
      }
      const baselineInput = {
        trueCount: baseline.trueCount,
        evaluatedCount: baseline.evaluatedCount,
        reasonDistribution: baseline.reasonDistribution as unknown as Record<string, number>,
      }

      const candidateResults = evaluateAllRules(currentInput, baselineInput, input.candidatePolicy)
      const baselineResults = evaluateAllRules(currentInput, baselineInput, input.baselinePolicy)

      for (const candidateResult of candidateResults) {
        const baselineResult = baselineResults.find(
          (result) =>
            result.type === candidateResult.type && result.reason === candidateResult.reason,
        )
        if (candidateResult.exceeded && !(baselineResult?.exceeded ?? false)) {
          await prisma.policyBacktestFinding.create({
            data: {
              runId: run.id,
              fingerprint: computeFingerprint(
                candidateResult.type,
                fingerprintDimensions(labelDefinitionId, candidateResult),
              ),
              severity:
                input.candidatePolicy.rules.find((rule) => rule.type === candidateResult.type)
                  ?.severity ?? 'low',
              diffKind: 'new_in_candidate',
              detail: { snapshotId: current.id },
            },
          })
          findingCount++
        }
      }
      for (const baselineResult of baselineResults) {
        const candidateResult = candidateResults.find(
          (result) =>
            result.type === baselineResult.type && result.reason === baselineResult.reason,
        )
        if (baselineResult.exceeded && !(candidateResult?.exceeded ?? false)) {
          await prisma.policyBacktestFinding.create({
            data: {
              runId: run.id,
              fingerprint: computeFingerprint(
                baselineResult.type,
                fingerprintDimensions(labelDefinitionId, baselineResult),
              ),
              severity:
                input.baselinePolicy.rules.find((rule) => rule.type === baselineResult.type)
                  ?.severity ?? 'low',
              diffKind: 'missing_in_candidate',
              detail: { snapshotId: current.id },
            },
          })
          findingCount++
        }
      }
    }
  }

  await prisma.policyBacktestRun.update({
    where: { id: run.id },
    data: { status: 'completed', finishedAt: new Date(), summary: { findingCount } },
  })

  return run.id
}
