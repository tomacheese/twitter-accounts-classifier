import type { PrismaClient } from '../../generated/prisma'

const MODEL_KEY = 'account_summary'

/**
 * @param prisma - Prisma クライアント
 * @returns account_summary read model の現在の generationId
 */
async function getCurrentGenerationId(prisma: PrismaClient): Promise<string | null> {
  const pointer = await prisma.readModelPointer.findUnique({ where: { modelKey: MODEL_KEY } })
  return pointer?.currentGenerationId ?? null
}

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

const RELATION_LIMIT = 50

/**
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント ID
 * @returns このアカウントが関与する Block 関係
 */
export async function getAccountRelations(
  prisma: PrismaClient,
  accountId: string,
): Promise<AccountRelationView[]> {
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: accountId }, { blockedId: accountId }] },
    take: RELATION_LIMIT,
  })
  const counterpartIds = blocks.map((block) =>
    block.blockerId === accountId ? block.blockedId : block.blockerId,
  )
  const counterparts = await prisma.account.findMany({
    where: { id: { in: counterpartIds } },
  })
  const screenNameById = new Map(counterparts.map((account) => [account.id, account.screenName]))

  return blocks.map((block) => {
    const counterpartAccountId = block.blockerId === accountId ? block.blockedId : block.blockerId
    return {
      blockId: block.id,
      direction: block.blockerId === accountId ? 'blocker' : 'blocked',
      counterpartAccountId,
      counterpartScreenName: screenNameById.get(counterpartAccountId) ?? counterpartAccountId,
      status: block.status,
    }
  })
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
  generationId: string | null
}

/**
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

  const generationId = await getCurrentGenerationId(prisma)

  return {
    accountId: account.id,
    firstSeenAt: account.firstSeenAt,
    lastCrawledAt: account.lastCrawledAt,
    updatedAt: account.updatedAt,
    generationId,
  }
}
