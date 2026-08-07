import type { PrismaClient } from '../generated/prisma'

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/**
 * buildAccountSummary の入力。
 */
export interface BuildAccountSummaryInput {
  /** 書き込み先の generationId。 */
  generationId: string
  /** 集計の基準時刻。 */
  sourceWatermarkAt: Date
  /** 1 ページあたりの Account 取得件数。 */
  pageSize?: number
}

/**
 * @param a - 比較対象の severity (null は severity なし扱い)
 * @param b - 比較対象の severity
 * @returns より深刻な方の severity
 */
function maxSeverity(a: string | null, b: string): string {
  if (!a) return b
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b
}

/**
 * Account を大量件数でも一括ロードせずカーソルページングで処理するため、
 * ページサイズを固定値ではなくオプション化してテストで小さい値へ差し替え可能にする。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generationId と検索基準時刻
 * @returns 作成した行数
 */
export async function buildAccountSummary(
  prisma: PrismaClient,
  input: BuildAccountSummaryInput,
): Promise<{ rowCount: number }> {
  const pageSize = input.pageSize ?? 2000
  let rowCount = 0
  let cursor: string | undefined

  // LabelDefinition は件数が少なく全ページで共通のため、ページごとに join せず一度だけ引く。
  const labelDefinitions = await prisma.labelDefinition.findMany({
    select: { id: true, key: true },
  })
  const labelKeyById = new Map(
    labelDefinitions.map((definition) => [definition.id, definition.key]),
  )

  for (;;) {
    const accounts = await prisma.account.findMany({
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, screenName: true, displayName: true, updatedAt: true },
    })
    if (accounts.length === 0) break

    const accountIds = accounts.map((account) => account.id)

    const [activeLabels, activeFindings] = await Promise.all([
      prisma.accountLabelLatest.findMany({
        where: { accountId: { in: accountIds }, value: true },
        select: { accountId: true, labelDefinitionId: true, labeledAt: true },
      }),
      prisma.reviewFinding.findMany({
        where: {
          status: { in: ['active', 'recurring'] },
          primaryScopeType: 'account',
          primaryScopeId: { in: accountIds },
        },
        select: { primaryScopeId: true, currentSeverity: true },
      }),
    ])

    const labelsByAccount = new Map<string, { labelDefinitionId: string; labeledAt: Date }[]>()
    for (const label of activeLabels) {
      const list = labelsByAccount.get(label.accountId) ?? []
      list.push({ labelDefinitionId: label.labelDefinitionId, labeledAt: label.labeledAt })
      labelsByAccount.set(label.accountId, list)
    }

    const findingsByAccount = new Map<string, { count: number; highestSeverity: string | null }>()
    for (const finding of activeFindings) {
      const entry = findingsByAccount.get(finding.primaryScopeId) ?? {
        count: 0,
        highestSeverity: null,
      }
      entry.count++
      entry.highestSeverity = maxSeverity(entry.highestSeverity, finding.currentSeverity)
      findingsByAccount.set(finding.primaryScopeId, entry)
    }

    await prisma.accountSummaryCurrent.createMany({
      data: accounts.map((account) => {
        const labels = labelsByAccount.get(account.id) ?? []
        const finding = findingsByAccount.get(account.id)
        let lastLabeledAt: Date | null = null
        for (const label of labels) {
          if (!lastLabeledAt || label.labeledAt > lastLabeledAt) lastLabeledAt = label.labeledAt
        }
        const activeLabelKeys = labels
          .map((label) => labelKeyById.get(label.labelDefinitionId))
          .filter((key): key is string => key !== undefined)
        return {
          generationId: input.generationId,
          accountId: account.id,
          normalizedScreenName: account.screenName.toLowerCase(),
          normalizedDisplayName: account.displayName.toLowerCase(),
          searchDocument: `${account.screenName} ${account.displayName}`.toLowerCase(),
          activeLabelKeys,
          activeLabelCount: activeLabelKeys.length,
          lastClassificationChangedAt: lastLabeledAt,
          lastRuleVersionChangedAt: null,
          activeFindingCount: finding?.count ?? 0,
          highestFindingSeverity: finding?.highestSeverity ?? null,
          sourceWatermarkAt: input.sourceWatermarkAt,
        }
      }),
    })

    rowCount += accounts.length
    cursor = accounts.at(-1)?.id
    if (accounts.length < pageSize) break
  }

  return { rowCount }
}
