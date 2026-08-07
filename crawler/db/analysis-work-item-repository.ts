import type { Prisma, PrismaClient } from '../generated/prisma'

export interface EnqueueWorkItemInput {
  kind: string
  triggerType: string
  triggerId: string
}

/**
 * analyzer/queue/work-item-repository.ts の enqueueWorkItem と同じ契約を持つ、
 * crawler 側 Prisma Client 向けの実装。ワークスペースが分かれ Prisma Client の
 * 型が別物になるため、ロジックを共有 package化せずそれぞれで持つ
 * (analyzer 側の変更を crawler 側でも変える必要がある点は CI の両テストで検知する)。
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
