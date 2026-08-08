import type { PrismaClient } from '../../generated/prisma'
import { getReadModelReadiness, type ReadModelReadinessStatus } from '../read-model-meta'

const MODEL_KEY = 'label_summary'

/** ラベル一覧の 1 行。 */
export interface LabelSummaryListItem {
  labelDefinitionId: string
  labelKey: string
  prevalence: number
  qualityStatus: string
  activeFindingCount: number
  highestFindingSeverity: string | null
}

/** listLabelSummaries の返り値。 */
export interface ListLabelSummariesResult {
  items: LabelSummaryListItem[]
  readiness: ReadModelReadinessStatus
}

const QUALITY_STATUS_RANK: Record<string, number> = { degraded: 3, watch: 2, unknown: 1, stable: 0 }

/**
 * @param prisma - Prisma クライアント
 * @returns label_summary read model の現在の generationId
 */
async function getCurrentGenerationId(prisma: PrismaClient): Promise<string | null> {
  const pointer = await prisma.readModelPointer.findUnique({ where: { modelKey: MODEL_KEY } })
  return pointer?.currentGenerationId ?? null
}

/**
 * 初期 sort は degraded/watch → active Finding 有無 → impact (prevalence) → label name の順。
 * LabelSummaryCurrent は 1 generation あたり全 LabelDefinition 分しか無く高々数百件のため、
 * DB 側の ORDER BY ではなく取得後に JS でソートする (複合ランクを SQL CASE で組むより単純)。
 * `readiness.labels !== 'ready'` の間は `LabelSummaryCurrent` を問い合わせず、
 * bootstrap 未完了・generation 未完成を「0 件」ではなく明示的な readiness として返す。
 * @param prisma - Prisma クライアント
 * @returns 全ラベルの一覧と readiness
 */
export async function listLabelSummaries(prisma: PrismaClient): Promise<ListLabelSummariesResult> {
  const readiness = await getReadModelReadiness(prisma)
  if (readiness.labels !== 'ready') {
    return { items: [], readiness: readiness.labels }
  }

  const generationId = await getCurrentGenerationId(prisma)
  if (!generationId) return { items: [], readiness: readiness.labels }

  const rows = await prisma.labelSummaryCurrent.findMany({ where: { generationId } })
  const labelDefinitions = await prisma.labelDefinition.findMany({
    where: { id: { in: rows.map((row) => row.labelDefinitionId) } },
  })
  const keyById = new Map(labelDefinitions.map((label) => [label.id, label.key]))

  const items: LabelSummaryListItem[] = rows.map((row) => ({
    labelDefinitionId: row.labelDefinitionId,
    labelKey: keyById.get(row.labelDefinitionId) ?? row.labelDefinitionId,
    prevalence: row.prevalence,
    qualityStatus: row.qualityStatus,
    activeFindingCount: row.activeFindingCount,
    highestFindingSeverity: row.highestFindingSeverity,
  }))

  const sortedItems = items.toSorted((a, b) => {
    const qualityDiff =
      (QUALITY_STATUS_RANK[b.qualityStatus] ?? 0) - (QUALITY_STATUS_RANK[a.qualityStatus] ?? 0)
    if (qualityDiff !== 0) return qualityDiff
    const findingDiff = (b.activeFindingCount > 0 ? 1 : 0) - (a.activeFindingCount > 0 ? 1 : 0)
    if (findingDiff !== 0) return findingDiff
    const prevalenceDiff = b.prevalence - a.prevalence
    if (prevalenceDiff !== 0) return prevalenceDiff
    return a.labelKey.localeCompare(b.labelKey)
  })

  return { items: sortedItems, readiness: readiness.labels }
}
