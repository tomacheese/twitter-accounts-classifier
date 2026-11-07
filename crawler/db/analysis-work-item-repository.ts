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
  await tx.$executeRaw`
    INSERT INTO "AnalysisWorkItem" ("kind", "triggerType", "triggerId", "updatedAt")
    SELECT ${input.kind}, ${input.triggerType}, ${input.triggerId}, now()
    WHERE NOT EXISTS (
      SELECT 1 FROM "AnalysisWorkItemDone"
      WHERE "kind" = ${input.kind} AND "triggerType" = ${input.triggerType} AND "triggerId" = ${input.triggerId}
    )
    AND NOT EXISTS (
      SELECT 1 FROM "AnalysisWorkItem"
      WHERE "kind" = ${input.kind} AND "triggerType" = ${input.triggerType} AND "triggerId" = ${input.triggerId}
    )
    ON CONFLICT ("kind", "triggerType", "triggerId") DO NOTHING
  `
}

const ACCOUNT_RELABEL_KIND = 'account_relabel'
const ACCOUNT_RELABEL_TRIGGER_TYPE = 'account'
const TERMINAL_STATUSES = ['failed', 'dead']

/**
 * requestAccountRelabel の複数 account 版。既存行を 1 文の UPDATE で再 arm し、
 * 更新されなかった account だけを別の文で INSERT する。
 * 1 文にまとめると、完了処理が行を削除した直後の再要求を取りこぼす。
 * UPDATE は空振りし、INSERT は文開始時点のスナップショットで行が残って見えるためである。
 * 結合や NOT EXISTS を使わないのは、統計が古いと入れ子ループの全走査を選びかねないためである。
 * INSERT だけを分けるのは、衝突行でも識別子の採番が進み、再通知の多い経路で int4 を使い果たすためである。
 * 2 文の間に同じ account の行が作られた場合に備え、INSERT も同じ再 arm で衝突を処理する。
 * @param prisma - Prisma クライアント
 * @param accountIds - 再評価を要求する account の ID 一覧
 */
export async function requestAccountRelabelBulk(
  prisma: Prisma.TransactionClient | PrismaClient,
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) return

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
  const rearmAssignments = Prisma.sql`
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
  const rearmed = await prisma.$queryRaw<{ triggerId: string }[]>`
    UPDATE "AnalysisWorkItem"
    SET ${rearmAssignments}
    WHERE "AnalysisWorkItem"."kind" = ${ACCOUNT_RELABEL_KIND}
      AND "AnalysisWorkItem"."triggerType" = ${ACCOUNT_RELABEL_TRIGGER_TYPE}
      AND "AnalysisWorkItem"."triggerId" = ANY(${accountIds}::text[])
    RETURNING "AnalysisWorkItem"."triggerId"
  `
  const rearmedIds = new Set(rearmed.map((row) => row.triggerId))
  const missingIds = [...new Set(accountIds)].filter((id) => !rearmedIds.has(id))
  if (missingIds.length === 0) return

  await prisma.$executeRaw`
    INSERT INTO "AnalysisWorkItem" ("kind", "triggerType", "triggerId", "updatedAt")
    SELECT ${ACCOUNT_RELABEL_KIND}, ${ACCOUNT_RELABEL_TRIGGER_TYPE}, missing."triggerId", now()
    FROM UNNEST(${missingIds}::text[]) AS missing("triggerId")
    ON CONFLICT ("kind", "triggerType", "triggerId") DO UPDATE
    SET ${rearmAssignments}
  `
}

/**
 * account_relabel の再 arm 可能な enqueue。
 * 通常の enqueueWorkItem と異なり台帳を見ず、完了済み (キュー表に無い) の account も新しい行で積み直す。
 * failed/dead だった行は queued に戻し、leased 中は dirty marker (staleRequestedAt) を立てるだけに留める。
 * lease が失効し attemptCount も使い切った行は、保持していた worker が二度と complete しない。
 * dirty marker では再 arm できないため、terminal 行と同様に queued へ全リセットする。
 * @param prisma - Prisma クライアント
 * @param accountId - 再評価を要求する account の ID
 */
export async function requestAccountRelabel(
  prisma: Prisma.TransactionClient | PrismaClient,
  accountId: string,
): Promise<void> {
  await requestAccountRelabelBulk(prisma, [accountId])
}

export interface ClaimNextWorkItemInput {
  kinds: string[]
  leaseOwner: string
  leaseDurationMs: number
}

export interface WorkItemCandidate {
  id: number
  triggerId: string
}

export interface PeekWorkItemCandidatesInput {
  kinds: string[]
  limit: number
}

/**
 * claim 前の候補選択と同じ絞り込み条件・並び順で、lease を更新せず id・triggerId だけを読み取る。
 * 共有 index のような重い前処理を、候補が 0 件のときに省くために、claim する前に使う。
 * @param prisma - Prisma クライアント
 * @param input - 対象 kind と上限件数
 * @returns 候補 WorkItem の id・triggerId 一覧 (claim 時と同じ並び順)
 */
export async function peekWorkItemCandidates(
  prisma: PrismaClient,
  input: PeekWorkItemCandidatesInput,
): Promise<WorkItemCandidate[]> {
  if (input.limit <= 0) return []

  return prisma.$queryRaw<WorkItemCandidate[]>`
    SELECT "id", "triggerId"
    FROM "AnalysisWorkItem"
    WHERE "kind" = ANY(${input.kinds})
      AND "status" IN ('queued', 'leased', 'failed')
      AND "availableAt" <= now()
      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
      AND "attemptCount" < "maxAttempts"
    ORDER BY "priority" DESC, "availableAt" ASC
    LIMIT ${input.limit}
  `
}

export interface ClaimWorkItemBatchByIdsInput {
  ids: number[]
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
        AND "availableAt" <= now()
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
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

  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: number }[]>(
        `SELECT "id" FROM "AnalysisWorkItem"
       WHERE "kind" = ANY($1)
         AND "status" IN ('queued', 'leased', 'failed')
         AND "availableAt" <= now()
         AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
         AND "attemptCount" < "maxAttempts"
       ORDER BY "priority" DESC, "availableAt" ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
        input.kinds,
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
    },
    { maxWait: 15_000, timeout: 15_000 },
  )
}

export interface CompleteAccountRelabelWorkItemsBulkInput {
  workItemIds: number[]
  leaseOwner: string
}

/**
 * account_relabel の完了処理を複数 item まとめて 1 ラウンドトリップで行う。
 * 対象の全 item が同じ lease owner (同一 worker の同一グループ claim) を持つため、item ごとに往復する必要がない。
 * `claimStillLeasedWorkItemIdsForUpdate` と同じトランザクション内で呼び、
 * そちらが保持した行ロックの上でラベル・evidence 書き込みと合わせて完了させることを想定する。
 * 変更要求が来ていない item はキュー表から削除する。
 * 完了後の再要求は requestAccountRelabel が新しい行で受けるため、台帳には記録しない。
 * 要求の有無の確認と書き込みは行ロックの上で 1 文にまとめる。
 * @param prisma - Prisma クライアントまたはトランザクションクライアント
 * @param input - 対象 WorkItem の id 一覧と claim 時の lease owner
 * @returns lease を保持できていた item の id と、その完了ステータス
 */
export async function completeAccountRelabelWorkItemsBulk(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: CompleteAccountRelabelWorkItemsBulkInput,
): Promise<{ id: number; status: 'succeeded' | 'requeued' }[]> {
  if (input.workItemIds.length === 0) return []

  const rows = await prisma.$queryRaw<{ id: number; status: string }[]>`
    WITH target AS (
      SELECT "id", "staleRequestedAt" IS NOT NULL AS "requeue"
      FROM "AnalysisWorkItem"
      WHERE "id" = ANY(${input.workItemIds}) AND "leaseOwner" = ${input.leaseOwner}
      FOR UPDATE
    ),
    requeued AS (
      UPDATE "AnalysisWorkItem" AS item
      SET
        "status" = 'queued',
        "availableAt" = now(),
        "staleRequestedAt" = NULL,
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "attemptCount" = 0
      FROM target
      WHERE item."id" = target."id" AND target."requeue"
      RETURNING item."id"
    ),
    removed AS (
      DELETE FROM "AnalysisWorkItem" AS item
      USING target
      WHERE item."id" = target."id" AND NOT target."requeue"
      RETURNING item."id"
    )
    SELECT "id", 'queued' AS "status" FROM requeued
    UNION ALL
    SELECT "id", 'succeeded' AS "status" FROM removed
  `
  return rows.map((row) => ({
    id: row.id,
    status: row.status === 'queued' ? ('requeued' as const) : ('succeeded' as const),
  }))
}

export interface CompleteAccountRelabelWorkItemInput {
  workItemId: number
  leaseOwner: string
}

/**
 * account_relabel の完了処理。complete 直前に staleRequestedAt を確認し、
 * lease 中に新しい変更要求が来ていれば完了にせず queued へ戻す。
 * @param prisma - Prisma クライアント
 * @param input - 対象 WorkItem と claim 時の lease owner
 * @returns 'succeeded' | 'requeued' | 'lease_lost'(lease を失っていた場合)
 */
export async function completeAccountRelabelWorkItem(
  prisma: PrismaClient,
  input: CompleteAccountRelabelWorkItemInput,
): Promise<'succeeded' | 'requeued' | 'lease_lost'> {
  const results = await completeAccountRelabelWorkItemsBulk(prisma, {
    workItemIds: [input.workItemId],
    leaseOwner: input.leaseOwner,
  })
  const result = results.at(0)
  if (!result) return 'lease_lost'
  return result.status
}

export interface ClaimStillLeasedWorkItemIdsForUpdateInput {
  workItemIds: number[]
  leaseOwner: string
}

/**
 * 渡した id のうち、現時点でまだ leaseOwner が一致し lease が失効していない行を
 * `FOR UPDATE SKIP LOCKED` で行ロックしたうえで返す。単発の SELECT による生存確認では、
 * 確認直後に lease が失効し別 worker が再 claim・再評価・先に書き込みを終えてから、
 * この worker の古い評価結果が遅れて書き込まれると新しい結果を上書きしてしまう
 * (ラベル書き込みの CAS は評価状態の rev しか見ないため)。
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
): Promise<number[]> {
  if (input.workItemIds.length === 0) return []

  const rows = await tx.$queryRaw<{ id: number }[]>`
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
      -- 部分 index (status, availableAt, priority) を活かせる availableAt でソートする。
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
