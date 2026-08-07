import type { PrismaClient, AnalysisWorkItem } from '../generated/prisma'

export interface EnqueueWorkItemInput {
  kind: string
  triggerType: string
  triggerId: string
  priority?: number
  dependencyKey?: string
}

/**
 * kind + triggerType + triggerId の一意制約に対する upsert で冪等にする。
 * 既に queued/leased/failed で存在する場合は再実行対象として残し、
 * succeeded で存在する場合だけ何もしない (再実行不要な完了イベントの再通知を無視する)。
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

export interface ClaimNextWorkItemInput {
  kinds: string[]
  leaseOwner: string
  leaseDurationMs: number
}

/**
 * FOR UPDATE SKIP LOCKED で 1 件だけ claim する。
 * lease 期限切れ (leaseExpiresAt < now) の行も再 claim 対象に含めることで、
 * worker が異常終了しても別 worker が拾い直せるようにする。
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
         AND "status" IN ('queued', 'leased')
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

export interface CompleteWorkItemInput {
  workItemId: string
  leaseOwner: string
  status: 'succeeded' | 'failed' | 'dead'
  errorCode?: string
  errorSummary?: string
}

/**
 * lease owner と一致する場合だけ更新する。
 * 期限切れ owner が新しい結果で上書きすることを防ぐため、更新件数を見て真偽を返す。
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
    },
  })
  return result.count > 0
}
