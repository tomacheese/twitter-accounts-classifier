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
}

const ACCOUNT_RELABEL_KIND = 'account_relabel'
const SCAN_CURSOR_ID = 'singleton'

/**
 * label ごとの現行 ruleVersion coverage と account_relabel backlog を取得する。
 * coverage は value (true/false) では絞り込まない。正例が少ないラベルでも、
 * 「現行 ruleVersion で再評価済みかどうか」という進捗の意味を保つため。
 * label 定義数だけ COUNT を発行せず、AccountLabelLatest 側を 1 回の groupBy に集約してから
 * 手元で label 定義と突き合わせる。
 * @param prisma - Prisma クライアント
 * @returns label ごとの coverage・backlog・最終 scan cursor 更新時刻
 */
export async function getRelabelStatus(prisma: PrismaClient): Promise<RelabelStatus> {
  const [totalAccounts, labelDefinitions, coverageGroups, backlogGroups, cursor] =
    await Promise.all([
      prisma.account.count(),
      prisma.labelDefinition.findMany(),
      prisma.accountLabelLatest.groupBy({
        by: ['labelDefinitionId', 'ruleVersion'],
        _count: true,
      }),
      prisma.analysisWorkItem.groupBy({
        by: ['status'],
        where: { kind: ACCOUNT_RELABEL_KIND },
        _count: true,
      }),
      prisma.relabelScanCursor.findUnique({ where: { id: SCAN_CURSOR_ID } }),
    ])

  const coveredAccountsByDefinitionAndVersion = new Map(
    coverageGroups.map((group) => [
      `${group.labelDefinitionId}:${group.ruleVersion}`,
      group._count,
    ]),
  )
  const labelCoverage: RelabelLabelCoverage[] = labelDefinitions.map((definition) => ({
    key: definition.key,
    description: definition.description,
    currentRuleVersion: definition.currentRuleVersion,
    coveredAccounts: definition.currentRuleVersion
      ? (coveredAccountsByDefinitionAndVersion.get(
          `${definition.id}:${definition.currentRuleVersion}`,
        ) ?? 0)
      : 0,
    totalAccounts,
  }))

  const backlog: RelabelBacklogEntry[] = backlogGroups.map((group) => ({
    status: group.status,
    count: group._count,
  }))

  return { labelCoverage, backlog, scanCursorUpdatedAt: cursor?.updatedAt ?? null }
}
