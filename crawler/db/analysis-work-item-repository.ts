import type { AnalysisWorkItem, Prisma, PrismaClient } from '../generated/prisma'

export interface EnqueueWorkItemInput {
  kind: string
  triggerType: string
  triggerId: string
}

/**
 * analyzer/queue/work-item-repository.ts の enqueueWorkItem と同じ契約を持つ、
 * crawler 側 Prisma Client 向けの実装。
 * ワークスペースが分かれ Prisma Client の型が別物になるため、
 * ロジックを共有 package 化せずそれぞれで持つ。
 */
export async function enqueueWorkItem(
  tx: Prisma.TransactionClient | PrismaClient,
  input: EnqueueWorkItemInput,
): Promise<void> {
  await tx.analysisWorkItem.upsert({
    where: {
      kind_triggerType_triggerId: {
        kind: input.kind,
        triggerType: input.triggerType,
        triggerId: input.triggerId,
      },
    },
    create: input,
    update: {},
  })
}

const ACCOUNT_RELABEL_KIND = 'account_relabel'
const ACCOUNT_RELABEL_TRIGGER_TYPE = 'account'
const TERMINAL_STATUSES = ['succeeded', 'failed', 'dead']

/**
 * account_relabel の再 arm 可能な enqueue。通常の enqueueWorkItem と異なり、
 * succeeded/failed/dead だった行も queued に戻し、leased 中は dirty marker
 * (staleRequestedAt) を立てるだけに留める。
 * 1 回の UPDATE 文で完結させることで、既存行の status 確認と書き込みの間に
 * 他の呼び出しが割り込むレースを作らない。
 * @param prisma - Prisma クライアント
 * @param accountId - 再評価を要求する account の ID
 */
export async function requestAccountRelabel(
  prisma: Prisma.TransactionClient | PrismaClient,
  accountId: string,
): Promise<void> {
  const updated = await prisma.$executeRaw`
    UPDATE "AnalysisWorkItem"
    SET
      "status" = CASE WHEN "status" = ANY(${TERMINAL_STATUSES}) THEN 'queued' ELSE "status" END,
      "availableAt" = CASE WHEN "status" = ANY(${TERMINAL_STATUSES}) THEN now() ELSE "availableAt" END,
      "staleRequestedAt" = CASE WHEN "status" = 'leased' THEN now() ELSE "staleRequestedAt" END,
      "leaseOwner" = CASE WHEN "status" = ANY(${TERMINAL_STATUSES}) THEN NULL ELSE "leaseOwner" END,
      "leaseExpiresAt" = CASE WHEN "status" = ANY(${TERMINAL_STATUSES}) THEN NULL ELSE "leaseExpiresAt" END
    WHERE "kind" = ${ACCOUNT_RELABEL_KIND}
      AND "triggerType" = ${ACCOUNT_RELABEL_TRIGGER_TYPE}
      AND "triggerId" = ${accountId}
  `
  if (updated > 0) return

  try {
    await prisma.analysisWorkItem.create({
      data: {
        kind: ACCOUNT_RELABEL_KIND,
        triggerType: ACCOUNT_RELABEL_TRIGGER_TYPE,
        triggerId: accountId,
      },
    })
  } catch (error) {
    // 一意制約違反 (P2002) は、上記 UPDATE との間に他の呼び出しが先に作成した競合であり、
    // 既に queued として存在していることを意味するため無視してよい。
    const isUniqueConstraintError =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    if (!isUniqueConstraintError) throw error
  }
}

export interface ClaimNextWorkItemInput {
  kinds: string[]
  leaseOwner: string
  leaseDurationMs: number
}

/**
 * FOR UPDATE SKIP LOCKED で 1 件だけ claim する。
 * analyzer/queue/work-item-repository.ts の claimNextWorkItem と同じ契約を持つ、
 * crawler 側 Prisma Client 向けの実装。
 * @param prisma - Prisma クライアント
 * @param input - claim 対象の kind と lease 情報
 * @returns claim した WorkItem (対象が無ければ undefined)
 */
export async function claimNextWorkItem(
  prisma: PrismaClient,
  input: ClaimNextWorkItemInput,
): Promise<AnalysisWorkItem | undefined> {
  const now = new Date()
  const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs)

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "AnalysisWorkItem"
       WHERE "kind" = ANY($1)
         AND "status" IN ('queued', 'leased', 'failed')
         AND "availableAt" <= $2
         AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < $2)
         AND "attemptCount" < "maxAttempts"
       ORDER BY "priority" DESC, "availableAt" ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      input.kinds,
      now,
    )
    const target = rows.at(0)
    if (!target) return undefined

    return tx.analysisWorkItem.update({
      where: { id: target.id },
      data: {
        status: 'leased',
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
        attemptCount: { increment: 1 },
      },
    })
  })
}

export interface CompleteAccountRelabelWorkItemInput {
  workItemId: string
  leaseOwner: string
}

/**
 * account_relabel の完了処理。complete 直前に staleRequestedAt を確認し、
 * lease 中に新しい変更要求が来ていれば succeeded にせず queued へ戻す。
 * 確認と書き込みを 1 回の UPDATE 文にまとめることで、
 * チェックと書き込みの間に別の requestAccountRelabel が割り込むレースを作らない。
 * @param prisma - Prisma クライアント
 * @param input - 対象 WorkItem と claim 時の lease owner
 * @returns 'succeeded' | 'requeued' | 'lease_lost'(lease を失っていた場合)
 */
export async function completeAccountRelabelWorkItem(
  prisma: PrismaClient,
  input: CompleteAccountRelabelWorkItemInput,
): Promise<'succeeded' | 'requeued' | 'lease_lost'> {
  const rows = await prisma.$queryRaw<{ status: string }[]>`
    UPDATE "AnalysisWorkItem"
    SET
      "status" = CASE WHEN "staleRequestedAt" IS NOT NULL THEN 'queued' ELSE 'succeeded' END,
      "availableAt" = CASE WHEN "staleRequestedAt" IS NOT NULL THEN now() ELSE "availableAt" END,
      "staleRequestedAt" = NULL,
      "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL
    WHERE "id" = ${input.workItemId} AND "leaseOwner" = ${input.leaseOwner}
    RETURNING "status"
  `
  const row = rows.at(0)
  if (!row) return 'lease_lost'
  return row.status === 'queued' ? 'requeued' : 'succeeded'
}
