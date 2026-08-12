import type { PrismaClient } from '../generated/prisma'
import {
  structuredOutputSchema,
  type WeeklyReviewSampleJudgment,
} from '../weekly-review/structured-output-schema'

const MIN_DIAGNOSTIC_N_EFF = 20
const BIN_WIDTH = 0.1
const TARGET_SAMPLE_KINDS = new Set(['random_positive', 'random_negative'])
const TARGET_VERDICTS = new Set(['correct', 'false_positive', 'false_negative'])

export interface ComputeConfidenceDiagnosticsOptions {
  targetFrom?: Date
  targetTo?: Date
}

export interface ConfidenceDiagnosticsBin {
  binStart: number
  n: number
  nEff: number
  insufficientSupport: boolean
  correctnessRate?: number
  brierScore?: number
}

export interface ConfidenceDiagnosticsSnapshot {
  labelKey: string
  ruleVersion: string
  classifierValue: boolean
  /** この累積ウィンドウの最後尾になった WeeklyAnalysisRun.targetTo。 */
  asOf: Date
  bins: ConfidenceDiagnosticsBin[]
}

interface WeightedJudgment {
  judgment: WeeklyReviewSampleJudgment
  weight: number
}

function binStartOf(confidence: number): number {
  const bin = Math.floor(confidence / BIN_WIDTH) * BIN_WIDTH
  return Math.min(bin, 1 - BIN_WIDTH)
}

function summarizeBin(entries: WeightedJudgment[]): ConfidenceDiagnosticsBin {
  const binStart = binStartOf(entries[0].judgment.classifierConfidence)
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0)
  const totalWeightSquared = entries.reduce((sum, e) => sum + e.weight ** 2, 0)
  const nEff = totalWeightSquared === 0 ? 0 : totalWeight ** 2 / totalWeightSquared

  if (nEff < MIN_DIAGNOSTIC_N_EFF) {
    return { binStart, n: entries.length, nEff, insufficientSupport: true }
  }

  const correctWeight = entries
    .filter((e) => e.judgment.verdict === 'correct')
    .reduce((sum, e) => sum + e.weight, 0)
  const correctnessRate = correctWeight / totalWeight

  let brierWeightSum = 0
  for (const e of entries) {
    const outcome = e.judgment.verdict === 'correct' ? 1 : 0
    brierWeightSum += e.weight * (e.judgment.classifierConfidence - outcome) ** 2
  }
  const brierScore = brierWeightSum / totalWeight

  return {
    binStart,
    n: entries.length,
    nEff,
    insufficientSupport: false,
    correctnessRate,
    brierScore,
  }
}

function groupByBin(entries: WeightedJudgment[]): ConfidenceDiagnosticsBin[] {
  const byBin = new Map<number, WeightedJudgment[]>()
  for (const entry of entries) {
    const bin = binStartOf(entry.judgment.classifierConfidence)
    const existing = byBin.get(bin) ?? []
    existing.push(entry)
    byBin.set(bin, existing)
  }
  return [...byBin.values()]
    .map((group) => summarizeBin(group))
    .toSorted((a, b) => a.binStart - b.binStart)
}

/**
 * `WeeklyAnalysisRun.structuredOutput` に蓄積された weekly review の judgment を横断集計し、
 * confidence bin ごとの score-vs-correctness diagnostics (実際の正解率・n・n_eff) を計算する。
 * `confidence`/`evidenceScore` は校正されていない heuristic decision score であるため、
 * ここで返す指標は「confidence が高いほど実際に正しい割合が高いか」の診断であり、
 * 確率としての較正誤差 (calibration error) ではない。Brier score は参考値としてのみ含める。
 * `ruleVersion` が変わった時点でそのセルの累積はリセットする (異なる confidence 計算式の
 * judgment を混ぜないことを最優先する)。
 * @param prisma - Prisma クライアント
 * @param options - 対象期間 (省略時は全期間)
 * @returns `labelKey × ruleVersion × classifierValue` ごとの、各 WeeklyAnalysisRun を
 *   最後尾とするローリング累積スナップショットの配列
 */
export async function computeConfidenceDiagnostics(
  prisma: PrismaClient,
  options: ComputeConfidenceDiagnosticsOptions,
): Promise<ConfidenceDiagnosticsSnapshot[]> {
  const runs = await prisma.weeklyAnalysisRun.findMany({
    where: {
      status: { in: ['success', 'partial'] },
      structuredOutput: { not: undefined },
      ...(options.targetFrom || options.targetTo
        ? {
            targetTo: {
              ...(options.targetFrom ? { gte: options.targetFrom } : {}),
              ...(options.targetTo ? { lte: options.targetTo } : {}),
            },
          }
        : {}),
    },
    orderBy: { targetTo: 'asc' },
    select: { id: true, targetTo: true, structuredOutput: true },
  })

  const rollingByCell = new Map<string, { ruleVersion: string; entries: WeightedJudgment[] }>()
  const snapshots: ConfidenceDiagnosticsSnapshot[] = []

  for (const run of runs) {
    if (!run.structuredOutput || !run.targetTo) continue
    const parsed = structuredOutputSchema.safeParse(run.structuredOutput)
    if (!parsed.success || !parsed.data.review) continue
    if (parsed.data.review.strategyVersion.startsWith('risk-stratified/1')) continue

    const relevantJudgments = parsed.data.review.judgments.filter(
      (judgment) =>
        TARGET_SAMPLE_KINDS.has(judgment.sampleKind) &&
        TARGET_VERDICTS.has(judgment.verdict) &&
        judgment.classifierEvaluable !== false,
    )

    for (const judgment of relevantJudgments) {
      const cellKey = `${judgment.labelKey} ${judgment.classifierValue}`
      const existing = rollingByCell.get(cellKey)
      const weight = judgment.populationCount ?? 1
      if (existing?.ruleVersion === judgment.ruleVersion) {
        existing.entries.push({ judgment, weight })
      } else {
        // ruleVersion が変わった時点でそのセルの累積をリセットする。
        rollingByCell.set(cellKey, {
          ruleVersion: judgment.ruleVersion,
          entries: [{ judgment, weight }],
        })
      }
    }

    for (const [cellKey, cell] of rollingByCell) {
      const [labelKey, classifierValueRaw] = cellKey.split(' ')
      snapshots.push({
        labelKey,
        ruleVersion: cell.ruleVersion,
        classifierValue: classifierValueRaw === 'true',
        asOf: run.targetTo,
        bins: groupByBin(cell.entries),
      })
    }
  }

  return snapshots
}
