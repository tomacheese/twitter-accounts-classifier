import type { PrismaClient, AnalysisWorkItem } from '../generated/prisma'

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
 * kind + triggerType + triggerId の一意制約に対する upsert で冪等にする。
 * 既に queued/leased/failed で存在する場合は再実行対象として残し、
 * succeeded で存在する場合だけ何もしない (再実行不要な完了イベントの再通知を無視する)。
 * @param prisma - Prisma クライアント
 * @param input - enqueue する WorkItem の内容
 */
export async function enqueueWorkItem(
  prisma: PrismaClient,
  input: EnqueueWorkItemInput,
): Promise<void> {
  const existing = await prisma.analysisWorkItem.findUnique({
    where: {
      kind_triggerType_triggerId: {
        kind: input.kind,
        triggerType: input.triggerType,
        triggerId: input.triggerId,
      },
    },
  })
  if (existing?.status === 'succeeded') return

  await prisma.analysisWorkItem.upsert({
    where: {
      kind_triggerType_triggerId: {
        kind: input.kind,
        triggerType: input.triggerType,
        triggerId: input.triggerId,
      },
    },
    create: {
      kind: input.kind,
      triggerType: input.triggerType,
      triggerId: input.triggerId,
      priority: input.priority ?? 0,
      dependencyKey: input.dependencyKey,
    },
    update: {},
  })
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

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "AnalysisWorkItem"
       WHERE "kind" = ANY($1)
         AND "status" IN ('queued', 'leased', 'failed')
         AND "availableAt" <= $2
         AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < $2)
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

/**
 * completeWorkItem の入力。
 */
export interface CompleteWorkItemInput {
  /** 対象の WorkItem ID。 */
  workItemId: string
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
 * @param prisma - Prisma クライアント
 * @param input - 対象 WorkItem と記録する終了状態
 * @returns 更新できたら true、lease を失っていたら false
 */
export async function completeWorkItem(
  prisma: PrismaClient,
  input: CompleteWorkItemInput,
): Promise<boolean> {
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
  workItemId: string
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
): Promise<string> {
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
  analysisRunId: string
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
