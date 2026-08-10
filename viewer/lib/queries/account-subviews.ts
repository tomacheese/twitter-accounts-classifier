import type { PrismaClient } from '../../generated/prisma'
import type { ReadModelFreshnessStatus } from '../api-response'
import { getReadModelMeta } from '../read-model-meta'
import { decodeCursor, encodeCursor } from '../pagination/keyset-cursor'

/** Account 詳細の Overview subview。 */
export interface AccountOverviewView {
  accountId: string
  screenName: string
  displayName: string
  bio: string | null
  profileImageUrl: string | null
  followersCount: number
  followingCount: number
  isBlueVerified: boolean
  activeLabelKeys: string[]
  activeFindingCount: number
  highestFindingSeverity: string | null
  lastClassificationChangedAt: Date | null
}

/**
 * タブ切り替え時ではなく初期表示に含める唯一の subview。
 * Accounts 一覧・Global Search と同じ AccountSummaryLatest を参照する。
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント ID
 * @returns Overview subview のデータ。Account が存在しなければ null
 */
export async function getAccountOverview(
  prisma: PrismaClient,
  accountId: string,
): Promise<AccountOverviewView | null> {
  const account = await prisma.account.findUnique({ where: { id: accountId } })
  if (!account) return null

  const summary = await prisma.accountSummaryLatest.findUnique({ where: { accountId } })

  return {
    accountId: account.id,
    screenName: account.screenName,
    displayName: account.displayName,
    bio: account.bio,
    profileImageUrl: account.profileImageUrl,
    followersCount: account.followersCount,
    followingCount: account.followingCount,
    isBlueVerified: account.isBlueVerified,
    activeLabelKeys: summary?.activeLabelKeys ?? [],
    activeFindingCount: summary?.activeFindingCount ?? 0,
    highestFindingSeverity: summary?.highestFindingSeverity ?? null,
    lastClassificationChangedAt: summary?.lastClassificationChangedAt ?? null,
  }
}

/** 1 ラベル分の分類結果。 */
export interface AccountClassificationEntryView {
  labelKey: string
  value: boolean
  confidence: number
  reason: string
  lastChangedAt: Date
}

/**
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント ID
 * @returns AccountClassificationLatest における全ラベルの分類結果
 */
export async function getAccountClassification(
  prisma: PrismaClient,
  accountId: string,
): Promise<AccountClassificationEntryView[]> {
  const rows = await prisma.accountClassificationLatest.findMany({ where: { accountId } })
  const labelDefinitions = await prisma.labelDefinition.findMany({
    where: { id: { in: rows.map((row) => row.labelDefinitionId) } },
  })
  const keyById = new Map(labelDefinitions.map((label) => [label.id, label.key]))

  return rows.map((row) => ({
    labelKey: keyById.get(row.labelDefinitionId) ?? row.labelDefinitionId,
    value: row.value,
    confidence: row.confidence,
    reason: row.reason,
    lastChangedAt: row.observedAt,
  }))
}

/** アカウントを primary scope とする Finding の要約。 */
export interface AccountEvidenceView {
  findingId: string
  type: string
  currentSeverity: string
  status: string
}

/**
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント ID
 * @returns このアカウントを primary scope とする active/recurring Finding
 */
export async function getAccountEvidence(
  prisma: PrismaClient,
  accountId: string,
): Promise<AccountEvidenceView[]> {
  const findings = await prisma.reviewFinding.findMany({
    where: {
      primaryScopeType: 'account',
      primaryScopeId: accountId,
      status: { in: ['active', 'recurring'] },
    },
    orderBy: [{ lastDetectedAt: 'desc' }],
  })

  return findings.map((finding) => ({
    findingId: finding.id,
    type: finding.type,
    currentSeverity: finding.currentSeverity,
    status: finding.status,
  }))
}

/** アカウントが関与する Block 関係 1 件。 */
export interface AccountRelationView {
  blockId: string
  direction: 'blocker' | 'blocked'
  counterpartAccountId: string
  counterpartScreenName: string
  status: string
}

/** getAccountRelations のページング入力。 */
export interface GetAccountRelationsOptions {
  cursor?: string
  limit?: number
}

/** getAccountRelations の返り値。 */
export interface ListAccountRelationsResult {
  items: AccountRelationView[]
  nextCursor: string | null
  totalCount: number
}

const DEFAULT_RELATION_LIMIT = 25
const MAX_RELATION_LIMIT = 100

/**
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント ID
 * @param options - cursor・limit によるページング指定
 * @returns このアカウントが関与する Block 関係の 1 ページと総件数
 */
export async function getAccountRelations(
  prisma: PrismaClient,
  accountId: string,
  options: GetAccountRelationsOptions = {},
): Promise<ListAccountRelationsResult> {
  const accountFilter = { OR: [{ blockerId: accountId }, { blockedId: accountId }] }
  const limit = Math.min(options.limit ?? DEFAULT_RELATION_LIMIT, MAX_RELATION_LIMIT)
  const filterHash = JSON.stringify({ accountId })
  const cursorValues = options.cursor ? decodeCursor(options.cursor, filterHash) : null

  const cursorFilter =
    cursorValues && cursorValues.length >= 2
      ? {
          OR: [
            { firstSeenAt: { lt: new Date(cursorValues[0]) } },
            { firstSeenAt: new Date(cursorValues[0]), id: { lt: cursorValues[1] } },
          ],
        }
      : null

  const [blocks, totalCount] = await Promise.all([
    prisma.block.findMany({
      where: cursorFilter ? { AND: [accountFilter, cursorFilter] } : accountFilter,
      orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }),
    prisma.block.count({ where: accountFilter }),
  ])

  const hasMore = blocks.length > limit
  const page = hasMore ? blocks.slice(0, limit) : blocks
  const last = page.at(-1)
  const nextCursor =
    hasMore && last
      ? encodeCursor({ sortValues: [last.firstSeenAt.toISOString(), last.id], filterHash })
      : null

  const counterpartIds = page.map((block) =>
    block.blockerId === accountId ? block.blockedId : block.blockerId,
  )
  const counterparts = await prisma.account.findMany({
    where: { id: { in: counterpartIds } },
  })
  const screenNameById = new Map(counterparts.map((account) => [account.id, account.screenName]))

  const items = page.map((block) => {
    const counterpartAccountId = block.blockerId === accountId ? block.blockedId : block.blockerId
    return {
      blockId: block.id,
      direction: (block.blockerId === accountId ? 'blocker' : 'blocked') as 'blocker' | 'blocked',
      counterpartAccountId,
      counterpartScreenName: screenNameById.get(counterpartAccountId) ?? counterpartAccountId,
      status: block.status,
    }
  })

  return { items, nextCursor, totalCount }
}

/** ラベル変化履歴の 1 件。 */
export interface AccountLabelChangeView {
  id: string
  labelKey: string
  changeType: string
  previousValue: boolean | null
  newValue: boolean | null
  changedAt: Date
}

const HISTORY_LIMIT = 50

/**
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント ID
 * @returns 直近のラベル変化履歴
 */
export async function getAccountHistory(
  prisma: PrismaClient,
  accountId: string,
): Promise<AccountLabelChangeView[]> {
  const changes = await prisma.accountLabelChange.findMany({
    where: { accountId },
    orderBy: [{ changedAt: 'desc' }],
    take: HISTORY_LIMIT,
  })
  const labelDefinitions = await prisma.labelDefinition.findMany({
    where: { id: { in: changes.map((change) => change.labelDefinitionId) } },
  })
  const keyById = new Map(labelDefinitions.map((label) => [label.id, label.key]))

  return changes.map((change) => ({
    id: change.id,
    labelKey: keyById.get(change.labelDefinitionId) ?? change.labelDefinitionId,
    changeType: change.changeType,
    previousValue: change.previousValue,
    newValue: change.newValue,
    changedAt: change.changedAt,
  }))
}

/** Account 詳細の Technical subview。 */
export interface AccountTechnicalView {
  accountId: string
  firstSeenAt: Date
  lastCrawledAt: Date
  updatedAt: Date
  freshnessStatus: ReadModelFreshnessStatus
  sourceWatermarkAt: Date | null
}

/**
 * account_summary_latest は generation を持たないため、旧 generationId 表示の代わりに
 * freshness/watermark を表示する。
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント ID
 * @returns デバッグ・技術情報。Account が存在しなければ null
 */
export async function getAccountTechnical(
  prisma: PrismaClient,
  accountId: string,
): Promise<AccountTechnicalView | null> {
  const account = await prisma.account.findUnique({ where: { id: accountId } })
  if (!account) return null

  const meta = await getReadModelMeta(prisma, 'account_summary_latest')

  return {
    accountId: account.id,
    firstSeenAt: account.firstSeenAt,
    lastCrawledAt: account.lastCrawledAt,
    updatedAt: account.updatedAt,
    freshnessStatus: meta.freshnessStatus,
    sourceWatermarkAt: meta.sourceDataAt,
  }
}
