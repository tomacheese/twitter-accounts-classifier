import type { Prisma, PrismaClient } from '../generated/prisma'

export interface ReplyHijackEvidenceInput {
  accountId: string
  targetTweetId: string
  ruleVersion: string
  swarmSize: number
  averageSimilarity: number
  spanHours: number
  replyTweetIds: string[]
}

export type ReplyHijackEvidenceDetails = Omit<ReplyHijackEvidenceInput, 'accountId' | 'ruleVersion'>

export type ReplyHijackEvidenceClient = PrismaClient | Prisma.TransactionClient

/**
 * @param prisma - Prisma クライアントまたは transaction client
 * @param evidence - 保存する reply-hijack swarm の監査証跡
 */
export async function upsertReplyHijackEvidence(
  prisma: ReplyHijackEvidenceClient,
  evidence: ReplyHijackEvidenceInput,
): Promise<void> {
  await prisma.replyHijackEvidence.upsert({
    where: {
      accountId_targetTweetId_ruleVersion: {
        accountId: evidence.accountId,
        targetTweetId: evidence.targetTweetId,
        ruleVersion: evidence.ruleVersion,
      },
    },
    create: evidence,
    update: {
      observedAt: new Date(),
      swarmSize: evidence.swarmSize,
      averageSimilarity: evidence.averageSimilarity,
      spanHours: evidence.spanHours,
      replyTweetIds: evidence.replyTweetIds,
    },
  })
}
