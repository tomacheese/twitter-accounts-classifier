import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { enqueueWorkItem } from './analysis-work-item-repository'

const logger = Logger.configure('block-run-repository')

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
  outboxEntryId: string
}

/**
 * `BlockRun` を完了 (または失敗) 状態に確定する。
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
  await prisma.$transaction(async (tx) => {
    await tx.blockRun.update({ where: { id }, data: { finishedAt, status } })
    await enqueueWorkItem(tx, {
      kind: 'block_reconciliation',
      triggerType: 'block_run',
      triggerId: id,
    })
  })
}

/**
 * アカウント処理が進む限り定期的に呼び出す必要がある: `crawler` の `touchCrawlRunHeartbeat` と同じ考え方で、放置された run を後から検出できるようにするため。
 * @param prisma - Prisma クライアント
 * @param id - 対象の `BlockRun` ID
 * @param at - 記録する時刻
 * @param staleThresholdMs - 放置判定のしきい値 (ミリ秒)。staleAfterAt の算出に使う
 */
export async function touchBlockRunHeartbeat(
  prisma: PrismaClient,
  id: string,
  at: Date,
  staleThresholdMs: number,
): Promise<void> {
  await prisma.blockRun.update({
    where: { id },
    data: { lastHeartbeatAt: at, staleAfterAt: new Date(at.getTime() + staleThresholdMs) },
  })
}

/**
 * 単一の blocker プロセスだけが動作する前提で運用する: 複数プロセスの同時実行は想定しない。
 * `lastHeartbeatAt` が `staleThresholdMs` を超えて更新されていない `running` 行は、
 * 正常終了できなかったものとみなして `failed` に確定し、新しい run を作り直す
 * (`crawler` の `startOrResumeCrawlRun` と同じ考え方)。
 * @param prisma - Prisma クライアント
 * @param startedAt - 新規 run の開始時刻
 * @param staleThresholdMs - 放置判定のしきい値 (ミリ秒)。経過時間がこれを超えれば放置とみなす
 * @returns 使用する `BlockRun` の ID
 */
export async function startOrResumeBlockRun(
  prisma: PrismaClient,
  startedAt: Date,
  staleThresholdMs: number,
): Promise<{ id: string }> {
  const existingRun = await prisma.blockRun.findFirst({
    where: { status: 'running' },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, lastHeartbeatAt: true },
  })

  if (existingRun) {
    const isStale = startedAt.getTime() - existingRun.lastHeartbeatAt.getTime() > staleThresholdMs
    if (!isStale) {
      return { id: existingRun.id }
    }

    logger.warn(
      `Abandoning stale block run ${existingRun.id}: last heartbeat at ` +
        `${existingRun.lastHeartbeatAt.toISOString()}, exceeding staleThresholdMs=${staleThresholdMs}`,
    )
    await finishBlockRun(prisma, existingRun.id, existingRun.lastHeartbeatAt, 'failed')
  }

  const run = await prisma.blockRun.create({
    data: {
      startedAt,
      lastHeartbeatAt: startedAt,
      status: 'running',
      staleAfterAt: new Date(startedAt.getTime() + staleThresholdMs),
    },
  })
  return { id: run.id }
}

/**
 * 1 アカウント分のブロックサイクルの開始を示す `BlockAccountRun` を作成する。
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
 * `BlockAccountRun` を完了状態にし、集計値を確定する。
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
 * 同一 outboxEntryId に対して複数回呼ばれても (reconciliation による補修を含む)、
 * 重複した BlockAction 行を作らないよう outboxEntryId を一意キーとした upsert にする。
 * @param prisma - Prisma クライアント
 * @param params - 1 回のブロック試行の記録
 */
export async function recordBlockAction(
  prisma: PrismaClient,
  params: RecordBlockActionParams,
): Promise<void> {
  await prisma.blockAction.upsert({
    where: { outboxEntryId: params.outboxEntryId },
    create: params,
    update: { result: params.result, errorMessage: params.errorMessage },
  })
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
