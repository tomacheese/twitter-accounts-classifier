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
 * coverage は value (true/false) では絞り込まない。正例が少ない/0件のラベルでも
 * 「現行 ruleVersion で再評価済みかどうか」という進捗の意味を保つため。
 * @param prisma - Prisma クライアント
 * @returns label ごとの coverage・backlog・最終 scan cursor 更新時刻
 */
export async function getRelabelStatus(prisma: PrismaClient): Promise<RelabelStatus> {
  const totalAccounts = await prisma.account.count()
  const labelDefinitions = await prisma.labelDefinition.findMany()

  const labelCoverage: RelabelLabelCoverage[] = await Promise.all(
    labelDefinitions.map(async (definition) => {
      const coveredAccounts = definition.currentRuleVersion
        ? await prisma.accountLabelLatest.count({
            where: {
              labelDefinitionId: definition.id,
              ruleVersion: definition.currentRuleVersion,
            },
          })
        : 0
      return {
        key: definition.key,
        description: definition.description,
        currentRuleVersion: definition.currentRuleVersion,
        coveredAccounts,
        totalAccounts,
      }
    }),
  )

  const backlogGroups = await prisma.analysisWorkItem.groupBy({
    by: ['status'],
    where: { kind: ACCOUNT_RELABEL_KIND },
    _count: true,
  })
  const backlog: RelabelBacklogEntry[] = backlogGroups.map((group) => ({
    status: group.status,
    count: group._count,
  }))

  const cursor = await prisma.relabelScanCursor.findUnique({ where: { id: SCAN_CURSOR_ID } })

  return { labelCoverage, backlog, scanCursorUpdatedAt: cursor?.updatedAt ?? null }
}
