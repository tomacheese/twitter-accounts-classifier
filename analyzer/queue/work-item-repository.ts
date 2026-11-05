import { Prisma, type PrismaClient, type AnalysisWorkItem } from '../generated/prisma'

/**
 * enqueueWorkItem の入力。
 */
export interface EnqueueWorkItemInput {
  /** 処理種別。 */
  kind: string
  /** 起点となったエンティティの種別。 */
  triggerType: string
  /** 起点となったエンティティの ID。 */
  triggerId: string
  /** 大きいほど先に claim される優先度。 */
  priority?: number
  /** 同一キーの処理を直列化するための依存キー。 */
  dependencyKey?: string
}

/**
 * 論理キー (kind, triggerType, triggerId) で冪等に enqueue する。
 * キュー表に同じキーがあるとき、または台帳 (完了済み) にあるときは何もしない。
 * 識別子は ON CONFLICT でも採番が進むため、既存キーの再通知で消費しないよう、
 * 挿入前に NOT EXISTS で除外する。
 * 完了処理の commit と競合した場合だけ二重に積まれ得るが、処理は at-least-once を前提とする。
 * @param prisma - Prisma クライアントまたはトランザクションクライアント
 * @param input - enqueue する WorkItem の内容
 */
export async function enqueueWorkItem(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: EnqueueWorkItemInput,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "AnalysisWorkItem" ("kind", "triggerType", "triggerId", "priority", "dependencyKey", "updatedAt")
    SELECT ${input.kind}, ${input.triggerType}, ${input.triggerId}, ${input.priority ?? 0}, ${input.dependencyKey ?? null}, now()
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

/** キュー表または台帳から復元した WorkItem のうち、後続処理が参照する項目。 */
export type SettledWorkItem = Pick<
  AnalysisWorkItem,
  | 'id'
  | 'kind'
  | 'triggerType'
  | 'triggerId'
  | 'createdAt'
  | 'attemptCount'
  | 'status'
  | 'lastErrorCode'
  | 'lastErrorSummary'
>

interface WorkItemDoneRow {
  workItemId: number
  kind: string
  triggerType: string
  triggerId: string
  createdAt: Date
  attemptCount: number
}

function fromDone(done: WorkItemDoneRow): SettledWorkItem {
  return {
    id: done.workItemId,
    kind: done.kind,
    triggerType: done.triggerType,
    triggerId: done.triggerId,
    createdAt: done.createdAt,
    attemptCount: done.attemptCount,
    status: 'succeeded',
    lastErrorCode: null,
    lastErrorSummary: null,
  }
}

/**
 * 論理キーで WorkItem を引く。完了するとキュー表から消えるため、無ければ台帳を見る。
 * 完了処理は両表を 1 文で入れ替えるので、キュー表 → 台帳の順に読めば取りこぼさない。
 * @param prisma - Prisma クライアント
 * @param key - 論理キー
 * @returns 見つかった WorkItem。キュー表にも台帳にも無ければ undefined
 */
export async function findWorkItemByKey(
  prisma: PrismaClient,
  key: { kind: string; triggerType: string; triggerId: string },
): Promise<SettledWorkItem | undefined> {
  const queued = await prisma.analysisWorkItem.findUnique({
    where: { kind_triggerType_triggerId: key },
  })
  if (queued) return queued
  const done = await prisma.analysisWorkItemDone.findUnique({
    where: { kind_triggerType_triggerId: key },
  })
  return done ? fromDone(done) : undefined
}

/**
 * WorkItem の id から引く。AnalysisRun や post-completion の参照は、
 * 完了済みの WorkItem では台帳の workItemId を指すため、キュー表に無ければ台帳を見る。
 * @param prisma - Prisma クライアント
 * @param workItemId - WorkItem の id
 * @returns 見つかった WorkItem。保持期間を過ぎて台帳からも消えていれば undefined
 */
export async function findWorkItemById(
  prisma: PrismaClient,
  workItemId: number,
): Promise<SettledWorkItem | undefined> {
  const queued = await prisma.analysisWorkItem.findUnique({ where: { id: workItemId } })
  if (queued) return queued
  const done = await prisma.analysisWorkItemDone.findFirst({ where: { workItemId } })
  return done ? fromDone(done) : undefined
}

/**
 * claimNextWorkItem の入力。
 */
export interface ClaimNextWorkItemInput {
  /** claim 対象とする処理種別。 */
  kinds: string[]
  /** claim した worker を識別する文字列。 */
  leaseOwner: string
  /** lease の有効期間 (ミリ秒)。 */
  leaseDurationMs: number
}

/** deadLetterExhaustedWorkItem の入力。 */
export interface DeadLetterExhaustedWorkItemInput {
  /** dead-letter 対象とする処理種別。 */
  kinds: string[]
}

const STALE_ATTEMPT_ERROR = 'work item lease expired before completion'
const EXHAUSTED_ATTEMPTS_ERROR = 'work item lease expired after maximum attempts were exhausted'

/**
 * maxAttempts を消費済みで lease も切れた WorkItem を processor へ再投入せず dead にする。
 * 同時に異常終了した直前 attempt の running AnalysisRun を failed に閉じる。
 * @param prisma - Prisma クライアント
 * @param input - 対象 kind
 * @returns dead にした WorkItem。対象がなければ undefined
 */
export async function deadLetterExhaustedWorkItem(
  prisma: PrismaClient,
  input: DeadLetterExhaustedWorkItemInput,
): Promise<AnalysisWorkItem | undefined> {
  const now = new Date()
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: number }[]>(
        `SELECT "id" FROM "AnalysisWorkItem"
       WHERE "kind" = ANY($1)
         AND "status" IN ('queued', 'leased', 'failed')
         AND "availableAt" <= $2
         AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < $2)
         AND "attemptCount" >= "maxAttempts"
       ORDER BY "priority" DESC, "availableAt" ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
        input.kinds,
        now,
      )
      const target = rows.at(0)
      if (!target) return undefined

      await tx.analysisRun.updateMany({
        where: { workItemId: target.id, status: 'running' },
        data: { status: 'failed', finishedAt: now, errorSummary: EXHAUSTED_ATTEMPTS_ERROR },
      })
      return tx.analysisWorkItem.update({
        where: { id: target.id },
        data: {
          status: 'dead',
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorSummary: EXHAUSTED_ATTEMPTS_ERROR,
        },
      })
    },
    { maxWait: 15_000, timeout: 15_000 },
  )
}

/**
 * FOR UPDATE SKIP LOCKED で 1 件だけ claim する。
 * lease 期限切れ (leaseExpiresAt < now) の行も再 claim 対象に含めることで、
 * worker が異常終了しても別 worker が拾い直せるようにする。
 * failed も対象に含める。dead との区別は「再試行余地が残っているか」であり、
 * failed を除外すると再試行不能な dead と同義になってしまうため。
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

      await tx.analysisRun.updateMany({
        where: { workItemId: target.id, status: 'running' },
        data: { status: 'failed', finishedAt: now, errorSummary: STALE_ATTEMPT_ERROR },
      })
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

/**
 * completeWorkItem の入力。
 */
/** renewWorkItemLease の入力。 */
export interface RenewWorkItemLeaseInput {
  /** 対象 WorkItem の ID。 */
  workItemId: number
  /** 現在の lease owner。 */
  leaseOwner: string
  /** 更新後の lease 有効期間 (ミリ秒)。 */
  leaseDurationMs: number
}

/**
 * 実行中 WorkItem の lease を owner 一致時だけ延長する。長時間処理が初回 lease を超えても、
 * 生存中 worker の WorkItem を別 worker が再 claim しないようにする。
 * @param prisma - Prisma クライアント
 * @param input - 対象 WorkItem と lease 情報
 * @returns lease を更新できたら true、owner/status が変わっていれば false
 */
export async function renewWorkItemLease(
  prisma: PrismaClient,
  input: RenewWorkItemLeaseInput,
): Promise<boolean> {
  const now = new Date()
  const result = await prisma.analysisWorkItem.updateMany({
    where: { id: input.workItemId, leaseOwner: input.leaseOwner, status: 'leased' },
    data: { leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs) },
  })
  return result.count > 0
}

export interface CompleteWorkItemInput {
  /** 対象の WorkItem ID。 */
  workItemId: number
  /** claim 時に設定した lease owner。 */
  leaseOwner: string
  /** 記録する終了状態。 */
  status: 'succeeded' | 'failed' | 'dead'
  /** 失敗時のエラーコード。 */
  errorCode?: string
  /** 失敗時のエラー概要。 */
  errorSummary?: string
  /** failed 時に次の claim を許可する時刻。 */
  retryAvailableAt?: Date
}

const RETRY_BACKOFF_BASE_MS = 30 * 1000
const RETRY_BACKOFF_MAX_MS = 15 * 60 * 1000

/**
 * 失敗直後に availableAt を進めないと、claim 条件を満たしたままの WorkItem を
 * 同じ worker が即座に拾い直し、maxAttempts 分を数秒で使い切ってしまう。
 * 一時的な障害が回復する余地を残すため、試行回数に応じて指数的に待つ。
 * @param attemptCount - これまでに消費した試行回数
 * @returns 次に claim 可能となるまでの待機時間 (ミリ秒)
 */
export function computeRetryBackoffMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1)
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** exponent, RETRY_BACKOFF_MAX_MS)
}

/**
 * lease owner と一致する場合だけ更新する。
 * 期限切れ owner が新しい結果で上書きすることを防ぐため、更新件数を見て真偽を返す。
 * succeeded は、キュー表からの削除と台帳への記録を 1 文で行い、
 * 片方だけが反映される状態を作らない。
 * @param prisma - Prisma クライアント
 * @param input - 対象 WorkItem と記録する終了状態
 * @returns 更新できたら true、lease を失っていたら false
 */
export async function completeWorkItem(
  prisma: PrismaClient,
  input: CompleteWorkItemInput,
): Promise<boolean> {
  if (input.status === 'succeeded') {
    const rows = await prisma.$queryRaw<{ id: number }[]>`
      WITH removed AS (
        DELETE FROM "AnalysisWorkItem"
        WHERE "id" = ${input.workItemId} AND "leaseOwner" = ${input.leaseOwner}
        RETURNING "id", "kind", "triggerType", "triggerId", "attemptCount", "createdAt"
      )
      INSERT INTO "AnalysisWorkItemDone"
        ("kind", "triggerType", "triggerId", "workItemId", "attemptCount", "createdAt", "completedAt")
      SELECT "kind", "triggerType", "triggerId", "id", "attemptCount", "createdAt", now()
      FROM removed
      ON CONFLICT ("kind", "triggerType", "triggerId") DO UPDATE SET
        "workItemId" = EXCLUDED."workItemId",
        "attemptCount" = EXCLUDED."attemptCount",
        "createdAt" = EXCLUDED."createdAt",
        "completedAt" = EXCLUDED."completedAt"
      RETURNING "workItemId" AS "id"
    `
    return rows.length > 0
  }

  const result = await prisma.analysisWorkItem.updateMany({
    where: { id: input.workItemId, leaseOwner: input.leaseOwner },
    data: {
      status: input.status,
      lastErrorCode: input.errorCode,
      lastErrorSummary: input.errorSummary,
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(input.status === 'failed' && input.retryAvailableAt
        ? { availableAt: input.retryAvailableAt }
        : {}),
    },
  })
  return result.count > 0
}

/** startAnalysisRun の入力。 */
export interface StartAnalysisRunInput {
  /** 対象の WorkItem ID。 */
  workItemId: number
  /** claim 時に確定した試行回数。 */
  attemptNumber: number
}

/**
 * WorkItem の 1 attempt を AnalysisRun として記録し始める。
 * @param prisma - Prisma クライアント
 * @param input - 対象 WorkItem と試行回数
 * @returns 作成した AnalysisRun の ID
 */
export async function startAnalysisRun(
  prisma: PrismaClient,
  input: StartAnalysisRunInput,
): Promise<number> {
  const run = await prisma.analysisRun.create({
    data: {
      workItemId: input.workItemId,
      attemptNumber: input.attemptNumber,
      status: 'running',
    },
  })
  return run.id
}

/** finishAnalysisRun の入力。 */
export interface FinishAnalysisRunInput {
  /** 対象の AnalysisRun ID。 */
  analysisRunId: number
  /** 記録する終了状態。 */
  status: 'succeeded' | 'failed' | 'dead'
  /** 失敗時のエラーコード。 */
  errorCode?: string
  /** 失敗時のエラー概要。 */
  errorSummary?: string
}

/**
 * @param prisma - Prisma クライアント
 * @param input - 対象 AnalysisRun と記録する終了状態
 */
export async function finishAnalysisRun(
  prisma: PrismaClient,
  input: FinishAnalysisRunInput,
): Promise<void> {
  await prisma.analysisRun.update({
    where: { id: input.analysisRunId },
    data: {
      status: input.status,
      finishedAt: new Date(),
      errorCode: input.errorCode,
      errorSummary: input.errorSummary,
    },
  })
}
