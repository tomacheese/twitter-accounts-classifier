import type { PrismaClient } from '../generated/prisma'

/**
 * `startBlockAccountRun` に渡すパラメータ。
 */
export interface StartBlockAccountRunParams {
  blockRunId: string
  username: string
  startedAt: Date
}

/**
 * `finishBlockAccountRun` に渡すパラメータ。
 */
export interface FinishBlockAccountRunParams {
  finishedAt: Date
  status: string
  candidatesCount: number
  blockedCount: number
  failedCount: number
  errorMessage: string | null
}

/**
 * `recordBlockAction` に渡すパラメータ。
 */
export interface RecordBlockActionParams {
  blockAccountRunId: string
  blockerId: string
  blockedId: string
  labelDefinitionId: string
  confidence: number
  result: string
  errorMessage: string | null
}

/**
 * @param prisma - Prisma クライアント
 * @param startedAt - 新規 run の開始時刻
 * @returns 作成した `BlockRun` の ID
 */
export async function startBlockRun(
  prisma: PrismaClient,
  startedAt: Date,
): Promise<{ id: string }> {
  const run = await prisma.blockRun.create({
    data: { startedAt, lastHeartbeatAt: startedAt, status: 'running' },
  })
  return { id: run.id }
}

/**
 * @param prisma - Prisma クライアント
 * @param id - 対象の `BlockRun` ID
 * @param finishedAt - サイクルが完了 (または失敗) した時刻
 * @param status - run の最終 status ("completed" | "failed")
 */
export async function finishBlockRun(
  prisma: PrismaClient,
  id: string,
  finishedAt: Date,
  status: string,
): Promise<void> {
  await prisma.blockRun.update({ where: { id }, data: { finishedAt, status } })
}

/**
 * アカウント処理が進む限り定期的に呼び出す必要がある: `crawler` の `touchCrawlRunHeartbeat` と
 * 同じ考え方で、放置された run を後から検出できるようにするため。
 * @param prisma - Prisma クライアント
 * @param id - 対象の `BlockRun` ID
 * @param at - 記録する時刻
 */
export async function touchBlockRunHeartbeat(
  prisma: PrismaClient,
  id: string,
  at: Date,
): Promise<void> {
  await prisma.blockRun.update({ where: { id }, data: { lastHeartbeatAt: at } })
}

/**
 * @param prisma - Prisma クライアント
 * @param params - 対象の `BlockRun` ID・アカウント名・開始時刻
 * @returns 作成した `BlockAccountRun` の ID
 */
export async function startBlockAccountRun(
  prisma: PrismaClient,
  params: StartBlockAccountRunParams,
): Promise<{ id: string }> {
  const accountRun = await prisma.blockAccountRun.create({
    data: {
      blockRunId: params.blockRunId,
      username: params.username,
      startedAt: params.startedAt,
      status: 'running',
    },
  })
  return { id: accountRun.id }
}

/**
 * @param prisma - Prisma クライアント
 * @param id - 対象の `BlockAccountRun` ID
 * @param params - 完了時に確定する集計値と status
 */
export async function finishBlockAccountRun(
  prisma: PrismaClient,
  id: string,
  params: FinishBlockAccountRunParams,
): Promise<void> {
  await prisma.blockAccountRun.update({ where: { id }, data: params })
}

/**
 * @param prisma - Prisma クライアント
 * @param params - 1 回のブロック試行の記録
 */
export async function recordBlockAction(
  prisma: PrismaClient,
  params: RecordBlockActionParams,
): Promise<void> {
  await prisma.blockAction.create({ data: params })
}

/**
 * @param prisma - Prisma クライアント
 * @param blockerId - ブロックを実行する側のアカウント
 * @param blockedId - ブロック対象のアカウント
 * @returns この組について過去に `result = 'success'` の `BlockAction` が存在すれば true
 */
export async function hasSuccessfulBlockAction(
  prisma: PrismaClient,
  blockerId: string,
  blockedId: string,
): Promise<boolean> {
  const count = await prisma.blockAction.count({
    where: { blockerId, blockedId, result: 'success' },
  })
  return count > 0
}
