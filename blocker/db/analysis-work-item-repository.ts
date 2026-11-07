import type { Prisma, PrismaClient } from '../generated/prisma'

export interface EnqueueWorkItemInput {
  kind: string
  triggerType: string
  triggerId: string
}

/**
 * analyzer/queue/work-item-repository.ts の enqueueWorkItem と同じ契約を持つ、
 * blocker 側 Prisma Client 向けの実装。
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
