import type { PrismaClient } from '../../generated/prisma'

const MAX_RESULTS_PER_TYPE = 5

/** 横断検索のアカウント結果 1 件。 */
export interface GlobalSearchAccountResult {
  id: string
  screenName: string
  displayName: string
}

/** 横断検索のラベル結果 1 件。 */
export interface GlobalSearchLabelResult {
  id: string
  key: string
}

/** 横断検索の Finding 結果 1 件。 */
export interface GlobalSearchFindingResult {
  id: string
  type: string
}

/** 横断検索の Operation 結果 1 件。 */
export interface GlobalSearchOperationResult {
  id: string
  kind: string
}

/** entity type ごとにまとめた横断検索の結果。 */
export interface GlobalSearchResult {
  accounts: GlobalSearchAccountResult[]
  labels: GlobalSearchLabelResult[]
  findings: GlobalSearchFindingResult[]
  operations: GlobalSearchOperationResult[]
}

const ACCOUNT_SUMMARY_MODEL_KEY = 'account_summary'

/**
 * アカウント検索は Account 本体ではなく read model の AccountSummaryCurrent を引く。
 * normalizedDisplayName は pg_trgm の GIN 索引を使う contains、
 * normalizedScreenName は通常の btree 索引を使う startsWith で絞り込む。
 * screenName にも contains を使うと索引を使わない全表スキャンになるため区別している。
 * @param prisma - Prisma クライアント
 * @param query - 検索クエリ文字列
 * @returns 上限件数までのアカウント検索結果
 */
async function searchAccounts(
  prisma: PrismaClient,
  query: string,
): Promise<GlobalSearchAccountResult[]> {
  const pointer = await prisma.readModelPointer.findUnique({
    where: { modelKey: ACCOUNT_SUMMARY_MODEL_KEY },
  })
  if (!pointer) return []

  const rows = await prisma.accountSummaryCurrent.findMany({
    where: {
      generationId: pointer.currentGenerationId,
      OR: [
        { normalizedDisplayName: { contains: query, mode: 'insensitive' } },
        { normalizedScreenName: { startsWith: query, mode: 'insensitive' } },
        { accountId: query },
      ],
    },
    take: MAX_RESULTS_PER_TYPE,
  })

  return rows.map((row) => ({
    id: row.accountId,
    screenName: row.normalizedScreenName,
    displayName: row.normalizedDisplayName,
  }))
}

/**
 * Account の screenName/displayName、Label の key、Finding の id/type、
 * Operation の cycleId/sourceId のみを検索対象とする。
 * Tweet 本文は個人が特定可能な実データを含みうるため、意図的に除外する。
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
    searchAccounts(prisma, query),
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
      where: {
        OR: [
          { id: { contains: query, mode: 'insensitive' } },
          { sourceId: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: MAX_RESULTS_PER_TYPE,
    }),
  ])

  return {
    accounts,
    labels: labels.map((label) => ({ id: label.id, key: label.key })),
    findings: findings.map((finding) => ({ id: finding.id, type: finding.type })),
    operations: operations.map((cycle) => ({ id: cycle.id, kind: cycle.kind })),
  }
}

/** サイトナビゲーションの badge に出す件数。 */
export interface NavBadgeCounts {
  qualityReviewCount: number
  operationsCount: number
}

/**
 * サイトナビゲーションの badge に表示する件数を集計する。
 * Quality Review は `active`/`recurring` の Finding 件数、
 * Operations は `attentionRequired` な Cycle 件数とする。
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
