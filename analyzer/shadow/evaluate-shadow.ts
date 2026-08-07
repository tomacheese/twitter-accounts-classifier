import type { Prisma, PrismaClient } from '../generated/prisma'
import { evaluateLabelCountDrop } from '../findings/detectors/label-count-drop'
import { evaluateReasonDistributionShift } from '../findings/detectors/reason-distribution-shift'
import { computeFingerprint } from '../findings/fingerprint'
import type { DetectionPolicy } from '../policy/schema'

export interface EvaluateShadowInput {
  crawlRunId: string
  policy: DetectionPolicy
  policyHash: string
}

/**
 * 本番判定 (generateFindingsForCrawlCycle) と同じ検出器ロジックを、
 * `DetectorEvaluation.isShadow = true` だけへ書く薄いラッパーとして実行する。
 * ReviewFinding/ReviewFindingOccurrence を更新する本番判定関数を一切呼ばないため、
 * Overview/Review の表示には反映されない。
 * @param prisma - Prisma クライアント
 * @param input - 対象 crawl run と試験的に評価する policy
 */
export async function evaluateShadow(
  prisma: PrismaClient,
  input: EvaluateShadowInput,
): Promise<void> {
  const currentSnapshots = await prisma.labelMetricSnapshot.findMany({
    where: { sourceCrawlRunId: input.crawlRunId },
  })

  for (const snapshot of currentSnapshots) {
    const baseline = await prisma.labelMetricSnapshot.findFirst({
      where: {
        labelDefinitionId: snapshot.labelDefinitionId,
        sourceCrawlRunId: { not: input.crawlRunId },
        observedAt: { lt: snapshot.observedAt },
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
        await prisma.detectorEvaluation.create({
          data: {
            detectorType: rule.detectorType,
            fingerprint: computeFingerprint(rule.type, { label: snapshot.labelDefinitionId }),
            identityVersion: rule.identityVersion,
            isShadow: true,
            result: result as unknown as Prisma.InputJsonValue,
            policyHash: input.policyHash,
          },
        })
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
        await prisma.detectorEvaluation.create({
          data: {
            detectorType: rule.detectorType,
            fingerprint: computeFingerprint(rule.type, {
              label: snapshot.labelDefinitionId,
              reason: result.reason ?? '',
            }),
            identityVersion: rule.identityVersion,
            isShadow: true,
            result: result as unknown as Prisma.InputJsonValue,
            policyHash: input.policyHash,
          },
        })
      }
    }
  }
}
