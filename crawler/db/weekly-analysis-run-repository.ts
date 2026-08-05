import { Logger } from '@book000/node-utils'
import type { PrismaClient, WeeklyAnalysisRun } from '../generated/prisma'

const logger = Logger.configure('weekly-analysis-run-repository')

export type WeeklyAnalysisRunStatus = 'running' | 'success' | 'failed' | 'timeout'

export interface WeeklyAnalysisRunRecord {
  id: string
  startedAt: Date
  lastHeartbeatAt: Date
  finishedAt: Date | null
  staleAfterAt: Date | null
  status: WeeklyAnalysisRunStatus
  currentPhase: string | null
  errorMessage: string | null
  pullRequestNumber: number | null
  pullRequestUrl: string | null
  sampledAccountIds: unknown
  findings: string | null
  commitSha: string | null
}

export interface WeeklyAnalysisRunMutationResult {
  ok: boolean
  alreadyTerminal: boolean
  run: WeeklyAnalysisRunRecord | null
}

function toRecord(run: WeeklyAnalysisRun): WeeklyAnalysisRunRecord {
  return {
    id: run.id,
    startedAt: run.startedAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    finishedAt: run.finishedAt,
    staleAfterAt: run.staleAfterAt,
    status: run.status as WeeklyAnalysisRunStatus,
    currentPhase: run.currentPhase,
    errorMessage: run.errorMessage,
    pullRequestNumber: run.pullRequestNumber,
    pullRequestUrl: run.pullRequestUrl,
    sampledAccountIds: run.sampledAccountIds,
    findings: run.findings,
    commitSha: run.commitSha,
  }
}

/**
 * @param prisma - Prisma クライアント
 * @param startedAt - 実行の開始時刻
 * @param staleThresholdMs - 放置判定のしきい値 (ミリ秒)。staleAfterAt の算出に使う
 * @returns 作成した実行
 */
export async function createWeeklyAnalysisRun(
  prisma: PrismaClient,
  startedAt: Date,
  staleThresholdMs: number,
): Promise<WeeklyAnalysisRunRecord> {
  const run = await prisma.weeklyAnalysisRun.create({
    data: {
      startedAt,
      lastHeartbeatAt: startedAt,
      staleAfterAt: new Date(startedAt.getTime() + staleThresholdMs),
      status: 'running',
      sampledAccountIds: [],
    },
  })
  return toRecord(run)
}

/**
 * @param prisma - Prisma クライアント
 * @param id - `WeeklyAnalysisRun` の id
 * @returns 該当する実行。存在しなければ `null`
 */
export async function getWeeklyAnalysisRun(
  prisma: PrismaClient,
  id: string,
): Promise<WeeklyAnalysisRunRecord | null> {
  const run = await prisma.weeklyAnalysisRun.findUnique({ where: { id } })
  return run ? toRecord(run) : null
}

/**
 * @param prisma - Prisma クライアント
 * @returns 現在 `running` の実行 (新しい順)
 */
export async function listRunningWeeklyAnalysisRuns(
  prisma: PrismaClient,
): Promise<WeeklyAnalysisRunRecord[]> {
  const runs = await prisma.weeklyAnalysisRun.findMany({
    where: { status: 'running' },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  })
  return runs.map((run) => toRecord(run))
}

type WeeklyAnalysisRunUpdateData = Parameters<
  PrismaClient['weeklyAnalysisRun']['update']
>[0]['data']

// sampledAccountIds は呼び出し元の CompleteWeeklyAnalysisRunParams で unknown として
// 受け取っているため、Prisma の JSON 入力型へは実行時の互換性を前提に明示キャストする。
async function updateIfRunning(
  prisma: PrismaClient,
  id: string,
  data: Record<string, unknown>,
): Promise<WeeklyAnalysisRunMutationResult> {
  const { count } = await prisma.weeklyAnalysisRun.updateMany({
    where: { id, status: 'running' },
    data: data as WeeklyAnalysisRunUpdateData,
  })
  const run = await getWeeklyAnalysisRun(prisma, id)
  if (count === 0) {
    logger.warn(`WeeklyAnalysisRun ${id} was already terminal; skipped update`)
    return { ok: false, alreadyTerminal: run !== null && run.status !== 'running', run }
  }
  return { ok: true, alreadyTerminal: false, run }
}

/**
 * @param prisma - Prisma クライアント
 * @param id - 対象の `WeeklyAnalysisRun` の id
 * @param at - 記録する時刻
 * @param staleThresholdMs - 放置判定のしきい値 (ミリ秒)。staleAfterAt の算出に使う
 * @param currentPhase - 現在のフェーズ名
 * @returns 更新結果。既に終端状態だった場合は `alreadyTerminal: true`
 */
export async function touchWeeklyAnalysisRunHeartbeat(
  prisma: PrismaClient,
  id: string,
  at: Date,
  staleThresholdMs: number,
  currentPhase: string | null,
): Promise<WeeklyAnalysisRunMutationResult> {
  return updateIfRunning(prisma, id, {
    lastHeartbeatAt: at,
    staleAfterAt: new Date(at.getTime() + staleThresholdMs),
    currentPhase,
  })
}

export interface CompleteWeeklyAnalysisRunParams {
  sampledAccountIds: unknown
  findings: string | null
  commitSha: string | null
  pullRequestNumber: number | null
  pullRequestUrl: string | null
}

/**
 * @param prisma - Prisma クライアント
 * @param id - 対象の `WeeklyAnalysisRun` の id
 * @param finishedAt - 完了時刻
 * @param params - 完了時に確定する内容
 * @returns 更新結果。既に終端状態だった場合は `alreadyTerminal: true`
 */
export async function completeWeeklyAnalysisRun(
  prisma: PrismaClient,
  id: string,
  finishedAt: Date,
  params: CompleteWeeklyAnalysisRunParams,
): Promise<WeeklyAnalysisRunMutationResult> {
  return updateIfRunning(prisma, id, {
    finishedAt,
    status: 'success',
    currentPhase: null,
    errorMessage: null,
    ...params,
  })
}

/**
 * @param prisma - Prisma クライアント
 * @param id - 対象の `WeeklyAnalysisRun` の id
 * @param finishedAt - 失敗が確定した時刻
 * @param errorMessage - 失敗理由
 * @returns 更新結果。既に終端状態だった場合は `alreadyTerminal: true`
 */
export async function failWeeklyAnalysisRun(
  prisma: PrismaClient,
  id: string,
  finishedAt: Date,
  errorMessage: string,
): Promise<WeeklyAnalysisRunMutationResult> {
  return updateIfRunning(prisma, id, { finishedAt, status: 'failed', errorMessage })
}

/**
 * `failWeeklyAnalysisRun` と別関数にしているのは、
 * 停止放置検出によるタイムアウト終了とワークフロー自身が報告する失敗とを、
 * ダッシュボードの表示・原因調査で区別できるようにするため。
 * @param prisma - Prisma クライアント
 * @param id - 対象の `WeeklyAnalysisRun` の id
 * @param finishedAt - タイムアウトが確定した時刻
 * @param errorMessage - タイムアウト理由
 * @returns 更新結果。既に終端状態だった場合は `alreadyTerminal: true`
 */
export async function timeoutWeeklyAnalysisRun(
  prisma: PrismaClient,
  id: string,
  finishedAt: Date,
  errorMessage: string,
): Promise<WeeklyAnalysisRunMutationResult> {
  return updateIfRunning(prisma, id, { finishedAt, status: 'timeout', errorMessage })
}
