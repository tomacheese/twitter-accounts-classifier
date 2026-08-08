import { Logger } from '@book000/node-utils'
import type { Prisma, PrismaClient, WeeklyAnalysisRun } from '../generated/prisma'
import { enqueueWorkItem } from './analysis-work-item-repository'

const logger = Logger.configure('weekly-analysis-run-repository')

export type WeeklyAnalysisRunStatus = 'running' | 'success' | 'failed' | 'timeout'

const WEEKLY_ANALYSIS_RUN_STATUSES: readonly WeeklyAnalysisRunStatus[] = [
  'running',
  'success',
  'failed',
  'timeout',
]

/**
 * @param value - DB から読んだ生の status 値
 * @returns value が `WeeklyAnalysisRunStatus` のいずれかと一致するか
 */
export function isWeeklyAnalysisRunStatus(value: string): value is WeeklyAnalysisRunStatus {
  return (WEEKLY_ANALYSIS_RUN_STATUSES as readonly string[]).includes(value)
}

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
  if (!isWeeklyAnalysisRunStatus(run.status)) {
    throw new Error(`Unexpected WeeklyAnalysisRun status: ${run.status}`)
  }
  return {
    id: run.id,
    startedAt: run.startedAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    finishedAt: run.finishedAt,
    staleAfterAt: run.staleAfterAt,
    status: run.status,
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
  prisma: PrismaClient | Prisma.TransactionClient,
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

async function updateIfRunning(
  prisma: PrismaClient | Prisma.TransactionClient,
  id: string,
  data: Parameters<PrismaClient['weeklyAnalysisRun']['update']>[0]['data'],
): Promise<WeeklyAnalysisRunMutationResult> {
  const { count } = await prisma.weeklyAnalysisRun.updateMany({
    where: { id, status: 'running' },
    data,
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
  sampledAccountIds?: unknown
  findings?: string | null
  commitSha?: string | null
  pullRequestNumber?: number | null
  pullRequestUrl?: string | null
  /** analyzer が ReviewFinding へ取り込む構造化レビュー結果。 */
  structuredOutput?: unknown
}

/**
 * リカバリ経路 (`scripts/weekly-analyze.sh` が前回実行の PR 状態を追認する場合など) では
 * `pullRequestUrl` や `findings` を再指定せずに `complete` だけ呼ぶことがあるため、
 * 未指定のフィールドは既存の DB 値を維持し、指定されたフィールドだけ上書きする。
 * @param prisma - Prisma クライアント
 * @param id - 対象の `WeeklyAnalysisRun` の id
 * @param finishedAt - 完了時刻
 * @param params - 完了時に確定する内容。未指定のフィールドは既存値を維持する
 * @returns 更新結果。既に終端状態だった場合は `alreadyTerminal: true`
 */
export async function completeWeeklyAnalysisRun(
  prisma: PrismaClient,
  id: string,
  finishedAt: Date,
  params: CompleteWeeklyAnalysisRunParams,
): Promise<WeeklyAnalysisRunMutationResult> {
  const { sampledAccountIds, structuredOutput, ...rest } = params
  return prisma.$transaction(async (tx) => {
    const result = await updateIfRunning(tx, id, {
      finishedAt,
      status: 'success',
      currentPhase: null,
      errorMessage: null,
      ...rest,
      ...(sampledAccountIds !== undefined && {
        sampledAccountIds: sampledAccountIds as Prisma.InputJsonValue,
      }),
      ...(structuredOutput !== undefined && {
        structuredOutput: structuredOutput as Prisma.InputJsonValue,
      }),
    })
    if (result.ok) {
      await enqueueWorkItem(tx, {
        kind: 'weekly_review_ingest',
        triggerType: 'weekly_analysis_run',
        triggerId: id,
      })
    }
    return result
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
 * PR オープン直後に呼び、`complete` を待たずに pullRequestNumber/pullRequestUrl を記録する。
 * これにより、`complete` 呼び出し前にセッションが落ちても後続実行が PR の存在を検知できる。
 * @param prisma - Prisma クライアント
 * @param id - 対象の `WeeklyAnalysisRun` の id
 * @param pullRequestNumber - オープンした PR の番号
 * @param pullRequestUrl - オープンした PR の URL
 * @returns 更新結果。既に終端状態だった場合は `alreadyTerminal: true`
 */
export async function recordWeeklyAnalysisRunPullRequest(
  prisma: PrismaClient,
  id: string,
  pullRequestNumber: number,
  pullRequestUrl: string,
): Promise<WeeklyAnalysisRunMutationResult> {
  return updateIfRunning(prisma, id, { pullRequestNumber, pullRequestUrl })
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
