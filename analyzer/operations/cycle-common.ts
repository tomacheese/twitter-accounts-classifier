import type { PrismaClient } from '../generated/prisma'

/**
 * 起点 Run の完了時には必ず AnalysisWorkItem が enqueue される前提のもとで、
 * WorkItem 自体が存在しない場合に埋め込むエラー概要。
 * この文字列と analysisRunId: null の組み合わせを、廃止済み stage 削除の
 * phantom 判定条件としても再利用する。
 */
export const NEVER_ENQUEUED_ERROR_SUMMARY = 'work item was never enqueued'

/** OperationStage 1 件の状態。 */
export type StageStatus =
  | 'waiting'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'blocked_by_upstream'
  | 'delayed'
  | 'stale'
  | 'unknown'

/** OperationCycle 全体の状態。 */
export type CycleStatus =
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'delayed'
  | 'stale'
  | 'cancelled'
  | 'unknown'

/**
 * 起点 Stage が成功していても、必須後続 Stage が failed/未完了なら partial とする。
 * 起点成功後の後続失敗を成功として表示しないための判定を、この関数へ集約する。
 * @param requiredStages - 先頭が起点 Stage の状態列
 * @returns Cycle 全体の状態
 */
export function deriveCycleStatus(requiredStages: StageStatus[]): CycleStatus {
  if (requiredStages.includes('failed')) {
    return requiredStages[0] === 'failed' ? 'failed' : 'partial'
  }
  if (requiredStages.includes('partial')) return 'partial'
  // 必須 Stage が例外なく正常終了して skipped になることは無い。partial な起点データで
  // 後続処理が意図的に見送られた場合の明示状態として使うため、failed と同じ扱いにする。
  if (requiredStages.includes('skipped')) {
    return requiredStages[0] === 'succeeded' ? 'partial' : 'failed'
  }
  if (requiredStages.includes('blocked_by_upstream')) {
    return requiredStages[0] === 'succeeded' ? 'partial' : 'failed'
  }
  if (requiredStages.includes('running')) return 'running'
  if (requiredStages.every((status) => status === 'succeeded')) return 'succeeded'
  if (requiredStages.includes('stale')) return 'stale'
  if (requiredStages.includes('delayed')) return 'delayed'
  if (requiredStages.includes('unknown')) return 'unknown'
  // ここまで残るのは succeeded と waiting だけの組み合わせである。
  // 全て waiting なら起点 Stage 自体が未着手であり、scheduled とする。
  // 一部でも succeeded があれば起点は既に進んでいるため、running とする。
  if (requiredStages.every((status) => status === 'waiting')) return 'scheduled'
  return 'running'
}

/** AnalysisWorkItem から導出した Stage の状態と付随情報。 */
export interface WorkItemStage {
  /** Stage の状態。 */
  status: StageStatus
  /** これまでに消費した試行回数。 */
  attemptCount: number
  /** 直近の失敗のエラーコード。 */
  errorCode: string | undefined
  /** 直近の失敗のエラー概要。 */
  errorSummary: string | undefined
  /** 直近の AnalysisRun の ID。 */
  analysisRunId: string | undefined
  /** 直近の AnalysisRun の開始時刻。 */
  startedAt: Date | undefined
  /** 直近の AnalysisRun の完了時刻。 */
  finishedAt: Date | undefined
  /** 対応する AnalysisWorkItem が enqueue されているかどうか。 */
  workItemExists: boolean
}

/**
 * @param workItemStatus - AnalysisWorkItem.status の値
 * @returns 対応する Stage の状態
 */
function deriveWorkItemStatus(workItemStatus: string): StageStatus {
  switch (workItemStatus) {
    case 'queued': {
      return 'waiting'
    }
    case 'leased': {
      return 'running'
    }
    case 'succeeded': {
      return 'succeeded'
    }
    case 'failed':
    case 'dead': {
      return 'failed'
    }
    default: {
      return 'unknown'
    }
  }
}

/**
 * 起点 Run の完了時には必ず AnalysisWorkItem が enqueue される。
 * そのため WorkItem 自体が存在しないことは処理の欠落を意味し、
 * waiting ではなく failed として扱って Operations 画面が見逃さないようにする。
 * @param prisma - Prisma クライアント
 * @param kind - AnalysisWorkItem.kind
 * @param triggerType - AnalysisWorkItem.triggerType
 * @param triggerId - 起点となった Run の ID
 * @returns 対応する Stage の状態と付随情報
 */
export async function deriveWorkItemStage(
  prisma: PrismaClient,
  kind: string,
  triggerType: string,
  triggerId: string,
): Promise<WorkItemStage> {
  const workItem = await prisma.analysisWorkItem.findUnique({
    where: { kind_triggerType_triggerId: { kind, triggerType, triggerId } },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
  })
  if (!workItem) {
    return {
      status: 'failed',
      attemptCount: 0,
      errorCode: undefined,
      errorSummary: NEVER_ENQUEUED_ERROR_SUMMARY,
      analysisRunId: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      workItemExists: false,
    }
  }

  const latestRun = workItem.runs.at(0)
  return {
    // AnalysisRun ではなく WorkItem.status を正本にする。
    // AnalysisRun は attempt ごとの記録であり、dead へ落ちた WorkItem を
    // 最新 attempt の failed としか区別できないため、queue 側の状態を優先する。
    status: deriveWorkItemStatus(workItem.status),
    attemptCount: workItem.attemptCount,
    errorCode: workItem.lastErrorCode ?? undefined,
    errorSummary: workItem.lastErrorSummary ?? undefined,
    analysisRunId: latestRun?.id,
    startedAt: latestRun?.startedAt,
    finishedAt: latestRun?.finishedAt ?? undefined,
    workItemExists: true,
  }
}

/**
 * WorkItem が enqueue されていない Stage を、直前 Stage の状態に応じて差し替える。
 * waiting も running 相当として扱うのは、blocked_by_upstream への誤判定を防ぐためである。
 * WorkItem 自体は変更せず、Cycle/Stage の表示状態だけ差し替える。
 * @param stage - deriveWorkItemStage が返した Stage
 * @param upstreamStatus - 直前の必須 Stage の状態
 * @returns 差し替え後の Stage
 */
export function applyUpstreamBlocking(
  stage: WorkItemStage,
  upstreamStatus: StageStatus,
): WorkItemStage {
  if (stage.workItemExists) return stage
  if (upstreamStatus === 'succeeded' || upstreamStatus === 'partial') return stage
  if (upstreamStatus === 'running' || upstreamStatus === 'waiting') {
    return { ...stage, status: 'waiting' }
  }
  return { ...stage, status: 'blocked_by_upstream' }
}

/** upsertCycleWithStages が受け取る Stage 1 件分の入力。 */
export interface CycleStageInput {
  /** Cycle 内で Stage を一意に識別するキー。 */
  stageKey: string
  /** Stage の状態。 */
  status: StageStatus
  /** Stage の正本テーブルの種別。 */
  sourceType: string
  /** Stage の正本レコードの ID。 */
  sourceId: string
  /** これまでに消費した試行回数。 */
  attemptCount?: number
  /** 直近の失敗のエラーコード。 */
  errorCode?: string
  /** 直近の失敗のエラー概要。 */
  errorSummary?: string
  /** 紐づく AnalysisRun の ID。 */
  analysisRunId?: string
  /** Stage の開始時刻。 */
  startedAt?: Date
  /** Stage の完了時刻。 */
  finishedAt?: Date
}

/** upsertCycleWithStages の入力。 */
export interface UpsertCycleWithStagesInput {
  /** OperationCycle.kind。Viewer 側の絞り込み値と一致させる。 */
  kind: string
  /** 起点エンティティの種別。 */
  sourceType: string
  /** 起点エンティティの ID。 */
  sourceId: string
  /** Cycle の起動時刻。 */
  triggeredAt: Date
  /** 起点 Run の開始時刻。 */
  startedAt: Date | undefined
  /** 起点 Run の完了時刻。 */
  finishedAt: Date | undefined
  /** 先頭が起点 Stage となる Stage 列。 */
  stages: CycleStageInput[]
  /**
   * OperationCycle.modelVersion。呼び出し側の stage topology のバージョンを表す。
   * この関数は crawl/block/weekly_review すべての Cycle 種別で共有されるため、
   * ここでハードコードすると他の Cycle 種別の modelVersion を書き換えてしまう。
   */
  modelVersion: string
}

/**
 * Cycle 全体の状態を Stage 列から再計算し、Cycle と Stage をまとめて upsert する。
 * @param prisma - Prisma クライアント
 * @param input - Cycle のメタデータと Stage 列
 * @returns upsert した OperationCycle の ID
 */
export async function upsertCycleWithStages(
  prisma: PrismaClient,
  input: UpsertCycleWithStagesInput,
): Promise<{ cycleId: string }> {
  const cycleStatus = deriveCycleStatus(input.stages.map((stage) => stage.status))
  const attentionRequired =
    cycleStatus === 'partial' || cycleStatus === 'failed' || cycleStatus === 'stale'
  const currentStageKey = input.stages.find((stage) => stage.status !== 'succeeded')?.stageKey

  const cycle = await prisma.operationCycle.upsert({
    where: { sourceType_sourceId: { sourceType: input.sourceType, sourceId: input.sourceId } },
    create: {
      kind: input.kind,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      triggeredAt: input.triggeredAt,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      status: cycleStatus,
      attentionRequired,
      currentStageKey,
      modelVersion: input.modelVersion,
    },
    update: {
      status: cycleStatus,
      finishedAt: input.finishedAt,
      attentionRequired,
      currentStageKey,
      modelVersion: input.modelVersion,
    },
  })

  let sequence = 0
  for (const stage of input.stages) {
    sequence++
    const isTerminal = stage.status === 'succeeded' || stage.status === 'failed'
    const finishedAt = stage.finishedAt ?? (isTerminal ? new Date() : undefined)
    await prisma.operationStage.upsert({
      where: { cycleId_stageKey: { cycleId: cycle.id, stageKey: stage.stageKey } },
      create: {
        cycleId: cycle.id,
        stageKey: stage.stageKey,
        sequence,
        requiredness: 'required',
        status: stage.status,
        attemptCount: stage.attemptCount ?? 0,
        sourceType: stage.sourceType,
        sourceId: stage.sourceId,
        startedAt: stage.startedAt,
        finishedAt,
        errorCode: stage.errorCode,
        errorSummary: stage.errorSummary,
        analysisRunId: stage.analysisRunId,
      },
      update: {
        status: stage.status,
        attemptCount: stage.attemptCount ?? 0,
        startedAt: stage.startedAt,
        finishedAt,
        errorCode: stage.errorCode ?? null,
        errorSummary: stage.errorSummary ?? null,
        analysisRunId: stage.analysisRunId,
      },
    })
  }

  return { cycleId: cycle.id }
}

/**
 * 現行の stage topology に存在しない OperationStage を削除する。
 * WHERE 句自体を phantom 条件 (WorkItem 未 enqueue 由来の失敗) に限定することで、
 * この関数がどの呼び出し経路から実行されても、旧 pipeline の正当な実行履歴を
 * 誤って削除しない構造的な安全性を持たせる。
 * @param prisma - Prisma クライアント
 * @param cycleId - 対象 OperationCycle の ID
 * @param keepStageKeys - 現行 topology で保持すべき stageKey の一覧
 */
export async function deleteObsoleteOperationStages(
  prisma: PrismaClient,
  cycleId: string,
  keepStageKeys: string[],
): Promise<void> {
  await prisma.operationStage.deleteMany({
    where: {
      cycleId,
      stageKey: { notIn: keepStageKeys },
      analysisRunId: null,
      errorSummary: NEVER_ENQUEUED_ERROR_SUMMARY,
    },
  })
}
