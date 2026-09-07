import type { PrismaClient } from '../generated/prisma'

/** watermark 時点で active だった Finding 1 件。 */
export interface ActiveFindingAtWatermark {
  severity: string
}

const OPEN_STATE_TRANSITIONS = new Set(['active', 'recurring', 'new_episode'])

/**
 * 1 Account 分の active Finding を `ReviewFindingOccurrence` から watermark 時点で復元する。
 * @param prisma - Prisma クライアント
 * @param accountId - 対象アカウント
 * @param sourceWatermarkAt - 復元する基準時刻
 * @returns watermark 時点で active だった Finding の severity 一覧
 */
export async function findActiveFindingsAtWatermarkForAccount(
  prisma: PrismaClient,
  accountId: string,
  sourceWatermarkAt: Date,
): Promise<ActiveFindingAtWatermark[]> {
  const rows = await prisma.$queryRaw<{ severity: string; stateTransition: string }[]>`
    SELECT DISTINCT ON (o."findingId") o."severity", o."stateTransition"
    FROM "ReviewFindingOccurrence" o
    JOIN "ReviewFinding" f ON f.id = o."findingId"
    WHERE f."primaryScopeType" = 'account' AND f."primaryScopeId" = ${accountId}
      AND o."sourceObservedAt" <= ${sourceWatermarkAt}
    ORDER BY o."findingId", o."sourceObservedAt" DESC, o.id DESC
  `
  return rows
    .filter((row) => OPEN_STATE_TRANSITIONS.has(row.stateTransition))
    .map((row) => ({ severity: row.severity }))
}
