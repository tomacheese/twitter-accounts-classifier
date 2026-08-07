import type { PrismaClient } from '../../generated/prisma'

const MAX_RESULTS_PER_TYPE = 5

export interface GlobalSearchAccountResult {
  id: string
  screenName: string
  displayName: string
}

export interface GlobalSearchLabelResult {
  id: string
  key: string
}

export interface GlobalSearchFindingResult {
  id: string
  type: string
}

export interface GlobalSearchOperationResult {
  id: string
  kind: string
}

export interface GlobalSearchResult {
  accounts: GlobalSearchAccountResult[]
  labels: GlobalSearchLabelResult[]
  findings: GlobalSearchFindingResult[]
  operations: GlobalSearchOperationResult[]
}

/**
 * Account の screenName/displayName、Label の key、Finding の id/type、
 * Operation の cycleId のみを検索対象とする。Tweet 本文は個人が特定可能な
 * 実データを含みうるため、意図的に検索対象から除外する。
 * @param prisma - Prisma クライアント
 * @param input - 検索クエリ文字列
 * @returns entity type ごとに上限件数までの検索結果
 */
export async function searchAcrossEntities(
  prisma: PrismaClient,
  input: { query: string },
): Promise<GlobalSearchResult> {
  const query = input.query.trim()
  if (!query) {
    return { accounts: [], labels: [], findings: [], operations: [] }
  }

  const [accounts, labels, findings, operations] = await Promise.all([
    prisma.account.findMany({
      where: {
        OR: [
          { screenName: { contains: query, mode: 'insensitive' } },
          { displayName: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: MAX_RESULTS_PER_TYPE,
    }),
    prisma.labelDefinition.findMany({
      where: { key: { contains: query, mode: 'insensitive' } },
      take: MAX_RESULTS_PER_TYPE,
    }),
    prisma.reviewFinding.findMany({
      where: {
        OR: [
          { id: { contains: query, mode: 'insensitive' } },
          { type: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: MAX_RESULTS_PER_TYPE,
    }),
    prisma.operationCycle.findMany({
      where: { id: { contains: query, mode: 'insensitive' } },
      take: MAX_RESULTS_PER_TYPE,
    }),
  ])

  return {
    accounts: accounts.map((account) => ({
      id: account.id,
      screenName: account.screenName,
      displayName: account.displayName,
    })),
    labels: labels.map((label) => ({ id: label.id, key: label.key })),
    findings: findings.map((finding) => ({ id: finding.id, type: finding.type })),
    operations: operations.map((cycle) => ({ id: cycle.id, kind: cycle.kind })),
  }
}

export interface NavBadgeCounts {
  qualityReviewCount: number
  operationsCount: number
}

/**
 * サイトナビゲーションの badge に表示する件数を集計する。
 * Quality Review は `active`/`recurring` の Finding 件数、Operations は
 * `attentionRequired` な Cycle 件数とする。
 * @param prisma - Prisma クライアント
 * @returns ナビゲーション badge 用の件数
 */
export async function getNavBadgeCounts(prisma: PrismaClient): Promise<NavBadgeCounts> {
  const [qualityReviewCount, operationsCount] = await Promise.all([
    prisma.reviewFinding.count({ where: { status: { in: ['active', 'recurring'] } } }),
    prisma.operationCycle.count({ where: { attentionRequired: true } }),
  ])

  return { qualityReviewCount, operationsCount }
}
