import { randomUUID } from 'node:crypto'
import { Prisma } from '../generated/prisma'
import type { AnalysisWorkItem, PrismaClient } from '../generated/prisma'

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
 * account_relabel の再 arm 可能な enqueue。
 * 通常の enqueueWorkItem と異なり、succeeded/failed/dead だった行も queued に戻し、
 * leased 中は dirty marker (staleRequestedAt) を立てるだけに留める。
 * ただし lease が既に失効し attemptCount も使い切った行は、保持していた worker が
 * 二度と complete しないため dirty marker では再 arm できず永久に取り残される。
 * この場合は terminal 行と同様に queued へ全リセットする。
 * 既存行の status 確認と書き込みを 1 回の UPDATE 文にまとめ、
 * 他の呼び出しが割り込むレースを避ける。
 * @param prisma - Prisma クライアント
 * @param accountId - 再評価を要求する account の ID
 */
export async function requestAccountRelabel(
  prisma: Prisma.TransactionClient | PrismaClient,
  accountId: string,
): Promise<void> {
  const resetCondition = Prisma.sql`(
    "status" = ANY(${TERMINAL_STATUSES})
    OR (
      "status" = 'leased'
      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
      AND "attemptCount" >= "maxAttempts"
    )
  )`
  const updated = await prisma.$executeRaw`
    UPDATE "AnalysisWorkItem"
    SET
      "status" = CASE WHEN ${resetCondition} THEN 'queued' ELSE "status" END,
      "availableAt" = CASE WHEN ${resetCondition} THEN now() ELSE "availableAt" END,
      "staleRequestedAt" = CASE
        WHEN ${resetCondition} THEN NULL
        WHEN "status" = 'leased' THEN now()
        ELSE "staleRequestedAt"
      END,
      "leaseOwner" = CASE WHEN ${resetCondition} THEN NULL ELSE "leaseOwner" END,
      "leaseExpiresAt" = CASE WHEN ${resetCondition} THEN NULL ELSE "leaseExpiresAt" END,
      "attemptCount" = CASE WHEN ${resetCondition} THEN 0 ELSE "attemptCount" END
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

/**
 * requestAccountRelabel の複数 account 版。1 account ずつ逐次 UPDATE/INSERT する代わりに、
 * UNNEST で展開した1本の INSERT ... ON CONFLICT 文にまとめてラウンドトリップを1回に抑える。
 * CASE の意味論は requestAccountRelabel と同じ。
 * @param prisma - Prisma クライアント
 * @param accountIds - 再評価を要求する account の ID 一覧
 */
export async function requestAccountRelabelBulk(
  prisma: Prisma.TransactionClient | PrismaClient,
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) return

  const ids = accountIds.map(() => randomUUID())
  const resetCondition = Prisma.sql`(
    "AnalysisWorkItem"."status" = ANY(${TERMINAL_STATUSES})
    OR (
      "AnalysisWorkItem"."status" = 'leased'
      AND (
        "AnalysisWorkItem"."leaseExpiresAt" IS NULL
        OR "AnalysisWorkItem"."leaseExpiresAt" < now()
      )
      AND "AnalysisWorkItem"."attemptCount" >= "AnalysisWorkItem"."maxAttempts"
    )
  )`
  await prisma.$executeRaw`
    INSERT INTO "AnalysisWorkItem" ("id", "kind", "triggerType", "triggerId", "updatedAt")
    SELECT u."id", ${ACCOUNT_RELABEL_KIND}, ${ACCOUNT_RELABEL_TRIGGER_TYPE}, u."triggerId", now()
    FROM UNNEST(${ids}::text[], ${accountIds}::text[]) AS u("id", "triggerId")
    ON CONFLICT ("kind", "triggerType", "triggerId") DO UPDATE
    SET
      "status" = CASE WHEN ${resetCondition} THEN 'queued' ELSE "AnalysisWorkItem"."status" END,
      "availableAt" = CASE WHEN ${resetCondition} THEN now() ELSE "AnalysisWorkItem"."availableAt" END,
      "staleRequestedAt" = CASE
        WHEN ${resetCondition} THEN NULL
        WHEN "AnalysisWorkItem"."status" = 'leased' THEN now()
        ELSE "AnalysisWorkItem"."staleRequestedAt"
      END,
      "leaseOwner" = CASE WHEN ${resetCondition} THEN NULL ELSE "AnalysisWorkItem"."leaseOwner" END,
      "leaseExpiresAt" = CASE WHEN ${resetCondition} THEN NULL ELSE "AnalysisWorkItem"."leaseExpiresAt" END,
      "attemptCount" = CASE WHEN ${resetCondition} THEN 0 ELSE "AnalysisWorkItem"."attemptCount" END
  `
}

export interface ClaimNextWorkItemInput {
  kinds: string[]
  leaseOwner: string
  leaseDurationMs: number
}

export interface WorkItemCandidate {
  id: string
  triggerId: string
}

export interface PeekWorkItemCandidatesInput {
  kinds: string[]
  limit: number
}

/**
 * claim 前の候補選択と同じ絞り込み条件・並び順で、lease を更新せず id・triggerId だけを読み取る。
 * follow-graph index のような重い前処理を、claim する前に候補の accountId 全体に対して
 * 1回だけ構築したい場合に使う。
 * @param prisma - Prisma クライアント
 * @param input - 対象 kind と上限件数
 * @returns 候補 WorkItem の id・triggerId 一覧 (claim 時と同じ並び順)
 */
export async function peekWorkItemCandidates(
  prisma: PrismaClient,
  input: PeekWorkItemCandidatesInput,
): Promise<WorkItemCandidate[]> {
  if (input.limit <= 0) return []

  const now = new Date()
  return prisma.$queryRaw<WorkItemCandidate[]>`
    SELECT "id", "triggerId"
    FROM "AnalysisWorkItem"
    WHERE "kind" = ANY(${input.kinds})
      AND "status" IN ('queued', 'leased', 'failed')
      AND "availableAt" <= ${now}
      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now})
      AND "attemptCount" < "maxAttempts"
    ORDER BY "priority" DESC, "availableAt" ASC
    LIMIT ${input.limit}
  `
}

export interface ClaimWorkItemBatchByIdsInput {
  ids: string[]
  leaseOwner: string
  leaseDurationMs: number
}

/**
 * peekWorkItemCandidates 等で固定した id 集合だけを対象に、ORDER BY/LIMIT による候補選択を
 * 行わず id = ANY(...) で対象を限定して FOR UPDATE SKIP LOCKED で claim する。
 * 競合で既に claim 済みの id は SKIP LOCKED により結果から自然に除外される。
 * @param prisma - Prisma クライアント
 * @param input - claim 対象の id 一覧と lease 情報
 * @returns 実際に claim できた WorkItem 一覧
 */
export async function claimWorkItemBatchByIds(
  prisma: PrismaClient,
  input: ClaimWorkItemBatchByIdsInput,
): Promise<AnalysisWorkItem[]> {
  if (input.ids.length === 0) return []

  const now = new Date()
  const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs)

  return prisma.$queryRaw<AnalysisWorkItem[]>`
    WITH claimable AS (
      SELECT "id"
      FROM "AnalysisWorkItem"
      WHERE "id" = ANY(${input.ids})
        AND "status" IN ('queued', 'leased', 'failed')
        AND "availableAt" <= ${now}
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now})
        AND "attemptCount" < "maxAttempts"
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "AnalysisWorkItem" AS item
    SET
      "status" = 'leased',
      "leaseOwner" = ${input.leaseOwner},
      "leaseExpiresAt" = ${leaseExpiresAt},
      "attemptCount" = item."attemptCount" + 1,
      "updatedAt" = ${now}
    FROM claimable
    WHERE item."id" = claimable."id"
    RETURNING item.*
  `
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
      "leaseExpiresAt" = NULL,
      "attemptCount" = 0
    WHERE "id" = ${input.workItemId} AND "leaseOwner" = ${input.leaseOwner}
    RETURNING "status"
  `
  const row = rows.at(0)
  if (!row) return 'lease_lost'
  return row.status === 'queued' ? 'requeued' : 'succeeded'
}

export interface CompleteAccountRelabelWorkItemsBulkInput {
  workItemIds: string[]
  leaseOwner: string
}

/**
 * account_relabel の完了処理を複数 item まとめて 1 ラウンドトリップで行う。
 * 対象の全 item が同じ lease owner (同一 worker の同一グループ claim) を持つため、item ごとに往復する必要がない。
 * `claimStillLeasedWorkItemIdsForUpdate` と同じトランザクション内で呼び、
 * そちらが保持した行ロックの上でラベル・evidence 書き込みと合わせて完了させることを想定する。
 * @param prisma - Prisma クライアントまたはトランザクションクライアント
 * @param input - 対象 WorkItem の id 一覧と claim 時の lease owner
 * @returns lease を保持できていた item の id と、その完了ステータス
 */
export async function completeAccountRelabelWorkItemsBulk(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: CompleteAccountRelabelWorkItemsBulkInput,
): Promise<{ id: string; status: 'succeeded' | 'requeued' }[]> {
  if (input.workItemIds.length === 0) return []

  const rows = await prisma.$queryRaw<{ id: string; status: string }[]>`
    UPDATE "AnalysisWorkItem"
    SET
      "status" = CASE WHEN "staleRequestedAt" IS NOT NULL THEN 'queued' ELSE 'succeeded' END,
      "availableAt" = CASE WHEN "staleRequestedAt" IS NOT NULL THEN now() ELSE "availableAt" END,
      "staleRequestedAt" = NULL,
      "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL,
      "attemptCount" = 0
    WHERE "id" = ANY(${input.workItemIds}) AND "leaseOwner" = ${input.leaseOwner}
    RETURNING "id", "status"
  `
  return rows.map((row) => ({
    id: row.id,
    status: row.status === 'queued' ? ('requeued' as const) : ('succeeded' as const),
  }))
}

export interface ClaimStillLeasedWorkItemIdsForUpdateInput {
  workItemIds: string[]
  leaseOwner: string
}

/**
 * 渡した id のうち、現時点でまだ leaseOwner が一致し lease が失効していない行を
 * `FOR UPDATE SKIP LOCKED` で行ロックしたうえで返す。単発の SELECT による生存確認では、
 * 確認直後に lease が失効し別 worker が再 claim・再評価・先に書き込みを終えてから、
 * この worker の古い評価結果が遅れて書き込まれると新しい結果を上書きしてしまう
 * (AccountLabelLatest の upsert guard は labeledAt の前後関係しか見ないため)。
 * この関数を呼び出したトランザクションが commit するまで行ロックを保持し続けることで、
 * 他 worker の再 claim (同じく FOR UPDATE SKIP LOCKED で行う) がこの行をロック中とみなして
 * スキップするようになり、生存確認からラベル・evidence 書き込み・work item 完了までの
 * 一連の処理を、再 claim に対して排他的にする。呼び出し元は必ず `prisma.$transaction` の
 * コールバック内で `tx` を渡し、返った id に対する後続の書き込みも同じ `tx` で行うこと。
 * 単独の SELECT として呼んでもロックは文の終了と同時に解放され、排他効果を持たない。
 * @param tx - トランザクションクライアント
 * @param input - 確認対象の id 一覧と claim 時の lease owner
 * @returns まだ lease を保持しておりロックを取得できた id の一覧
 */
export async function claimStillLeasedWorkItemIdsForUpdate(
  tx: Prisma.TransactionClient,
  input: ClaimStillLeasedWorkItemIdsForUpdateInput,
): Promise<string[]> {
  if (input.workItemIds.length === 0) return []

  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "AnalysisWorkItem"
    WHERE "id" = ANY(${input.workItemIds})
      AND "leaseOwner" = ${input.leaseOwner}
      AND "leaseExpiresAt" > now()
    FOR UPDATE SKIP LOCKED
  `
  return rows.map((row) => row.id)
}

export interface RecoverExhaustedExpiredWorkItemsInput {
  kind: string
  batchSize: number
}

export interface RecoverExhaustedExpiredWorkItemsResult {
  reArmed: number
  parkedAsFailed: number
}

/**
 * lease が失効し attemptCount も使い切ったまま status='leased' で取り残された行を回収する。
 * requestAccountRelabel(Bulk) は新しい request を受けた行しか救えないため、
 * 二度と request が来ない account の行は対象外になり、放置すると永久に leased のままになる。
 * staleRequestedAt が立っている行は既に変更要求があるので queued に戻し、
 * 立っていない行は maxAttempts の意味を保つため無限 retry させず failed に park し、
 * 後続の request/stale scan による再 arm を待つ。1 回あたりの対象件数を絞ることで、
 * 大量の取り残し行が溜まっていても 1 回の呼び出しが長時間の UPDATE にならないようにする。
 * @param prisma - Prisma クライアント
 * @param input - 対象 kind と 1 回あたりの回収件数上限
 * @returns 再 arm (queued へ復帰) した件数と failed に park した件数
 */
export async function recoverExhaustedExpiredWorkItems(
  prisma: PrismaClient,
  input: RecoverExhaustedExpiredWorkItemsInput,
): Promise<RecoverExhaustedExpiredWorkItemsResult> {
  const rows = await prisma.$queryRaw<{ status: string }[]>`
    WITH target AS (
      SELECT "id"
      FROM "AnalysisWorkItem"
      WHERE "kind" = ${input.kind}
        AND "status" = 'leased'
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
        AND "attemptCount" >= "maxAttempts"
      -- leaseExpiresAt に対応する index が無くフルソートになるため、
      -- 既存の (status, availableAt, priority) index を活かせる availableAt でソートする。
      -- 回収順序自体は正しさに影響しないため、コストの低い並びを優先してよい。
      ORDER BY "availableAt" ASC
      LIMIT ${input.batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "AnalysisWorkItem" AS item
    SET
      "status" = CASE WHEN item."staleRequestedAt" IS NOT NULL THEN 'queued' ELSE 'failed' END,
      "availableAt" = CASE WHEN item."staleRequestedAt" IS NOT NULL THEN now() ELSE item."availableAt" END,
      "attemptCount" = CASE WHEN item."staleRequestedAt" IS NOT NULL THEN 0 ELSE item."attemptCount" END,
      "staleRequestedAt" = NULL,
      "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL,
      "lastErrorSummary" = CASE
        WHEN item."staleRequestedAt" IS NULL THEN 'lease expired after exhausting maxAttempts'
        ELSE item."lastErrorSummary"
      END,
      "updatedAt" = now()
    FROM target
    WHERE item."id" = target."id"
    RETURNING item."status"
  `
  let reArmed = 0
  let parkedAsFailed = 0
  for (const row of rows) {
    if (row.status === 'queued') reArmed++
    else parkedAsFailed++
  }
  return { reArmed, parkedAsFailed }
}
