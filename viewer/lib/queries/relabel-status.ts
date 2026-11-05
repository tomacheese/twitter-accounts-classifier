import type { PrismaClient } from '../../generated/prisma'

/** 1 label 分の現行 ruleVersion coverage。 */
export interface RelabelLabelCoverage {
  key: string
  description: string
  currentRuleVersion: string | null
  coveredAccounts: number
  totalAccounts: number
}

/** account_relabel work item の status ごとの件数。 */
export interface RelabelBacklogEntry {
  status: string
  count: number
}

/** System 画面の Relabel backfill セクションの表示内容。 */
export interface RelabelStatus {
  labelCoverage: RelabelLabelCoverage[]
  backlog: RelabelBacklogEntry[]
  scanCursorUpdatedAt: Date | null
  /** coverage の元になったスナップショットの作成時刻。スナップショットがまだ無ければ null。 */
  coverageComputedAt: Date | null
}

const ACCOUNT_RELABEL_KIND = 'account_relabel'
const SCAN_CURSOR_ID = 'singleton'

/**
 * label ごとの現行 ruleVersion coverage と account_relabel backlog を取得する。
 * coverage は value (true/false) でも評価不能かどうかでも絞り込まない。正例が少ないラベルでも、
 * 「現行 ruleVersion で再評価済みかどうか」という進捗の意味を保つため。
 * 全アカウントの `AccountLabelState.versions` の集計は重いため画面からは行わず、
 * analyzer が定期的に作る `RelabelCoverageSnapshot` を読む。
 * そのため coverage は最大でスナップショットの間隔分だけ遅れる。
 * @param prisma - Prisma クライアント
 * @returns label ごとの coverage・backlog・最終 scan cursor 更新時刻
 */
export async function getRelabelStatus(prisma: PrismaClient): Promise<RelabelStatus> {
  const [totalAccounts, labelDefinitions, coverageRows, backlogGroups, cursor] = await Promise.all([
    prisma.account.count(),
    prisma.labelDefinition.findMany({
      where: { retiredAt: null },
      include: { ruleVersions: { select: { versionNo: true, ruleVersion: true } } },
      orderBy: { key: 'asc' },
    }),
    prisma.relabelCoverageSnapshot.findMany(),
    prisma.analysisWorkItem.groupBy({
      by: ['status'],
      where: { kind: ACCOUNT_RELABEL_KIND },
      _count: true,
    }),
    prisma.relabelScanCursor.findUnique({ where: { id: SCAN_CURSOR_ID } }),
  ])

  const coveredAccountsByDefinitionAndVersion = new Map(
    coverageRows.map((row) => [`${row.labelDefinitionId}:${row.versionNo}`, row.accountCount]),
  )
  const labelCoverage: RelabelLabelCoverage[] = labelDefinitions.map((definition) => {
    const currentVersionNo = definition.currentRuleVersionNo
    return {
      key: definition.key,
      description: definition.description,
      currentRuleVersion:
        definition.ruleVersions.find((version) => version.versionNo === currentVersionNo)
          ?.ruleVersion ?? null,
      coveredAccounts:
        currentVersionNo === null
          ? 0
          : (coveredAccountsByDefinitionAndVersion.get(`${definition.id}:${currentVersionNo}`) ??
            0),
      totalAccounts,
    }
  })

  const backlog: RelabelBacklogEntry[] = backlogGroups.map((group) => ({
    status: group.status,
    count: group._count,
  }))

  const coverageComputedAt =
    coverageRows.length === 0
      ? null
      : new Date(Math.max(...coverageRows.map((row) => row.computedAt.getTime())))

  return {
    labelCoverage,
    backlog,
    scanCursorUpdatedAt: cursor?.updatedAt ?? null,
    coverageComputedAt,
  }
}
